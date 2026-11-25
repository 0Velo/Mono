/**
 * Area 5 — transaction building and fee arithmetic.
 *
 * No network: a fake Connection answers the few reads the builders make, so the
 * tests prove the wallet's own logic (validation order, fee/rent maths) rather
 * than an RPC's behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ATA_RENT_LAMPORTS,
  BASE_FEE_LAMPORTS,
  estimateFee,
  fetchHistory,
  inspectTransaction,
  maxTransferableSol,
  prepareSolSend,
  prepareSplSend,
  sendSol,
  sendSplToken,
  signPreparedSend,
  TxOutcomeError,
  fetchHistory,
} from '../../../src/lib/tx'
import { PREVIEW_TTL_MS, assertMessageMatches } from '../../../src/lib/transactionPreview'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function fakeConnection(balance: number, accounts: Record<string, unknown> = {}) {
  return {
    getBalance: async () => balance,
    getAccountInfo: async (key: PublicKey) => accounts[key.toBase58()] ?? null,
    getLatestBlockhash: async () => {
      throw new Error('network must not be reached in this test')
    },
  } as any
}

test('BASE_FEE_LAMPORTS and ATA rent match Solana mainnet constants', () => {
  assert.equal(BASE_FEE_LAMPORTS, 5_000n)
  assert.equal(ATA_RENT_LAMPORTS, 2_039_280n)
})

test('maxTransferableSol always leaves the network fee behind', async () => {
  assert.equal(await maxTransferableSol(fakeConnection(10_000), Keypair.generate().publicKey), 5_000n)
  assert.equal(await maxTransferableSol(fakeConnection(5_000), Keypair.generate().publicKey), 0n)
  assert.equal(await maxTransferableSol(fakeConnection(4_999), Keypair.generate().publicKey), 0n)
  assert.equal(await maxTransferableSol(fakeConnection(0), Keypair.generate().publicKey), 0n)
})

test('estimateFee charges rent only when the recipient token account must be created', async () => {
  const owner = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const plain = fakeConnection(1_000_000_000, {
    [USDC]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) },
  })

  const sol = await estimateFee(plain, 'sol', owner, null, null)
  assert.deepEqual(sol, {
    feeLamports: BASE_FEE_LAMPORTS,
    rentLamports: 0n,
    totalLamports: BASE_FEE_LAMPORTS,
    createsAta: false,
  })

  const splNewAccount = await estimateFee(plain, 'spl', owner, USDC, recipient.toBase58())
  assert.equal(splNewAccount.createsAta, true)
  assert.equal(splNewAccount.rentLamports, ATA_RENT_LAMPORTS)
  assert.equal(splNewAccount.totalLamports, BASE_FEE_LAMPORTS + ATA_RENT_LAMPORTS)

  // Same call with the ATA present.
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token')
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC), recipient, false, TOKEN_PROGRAM_ID)
  const withAta = await estimateFee(
    fakeConnection(1_000_000_000, {
      [ata.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) },
      [USDC]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) },
    }),
    'spl',
    owner,
    USDC,
    recipient.toBase58(),
  )
  assert.equal(withAta.createsAta, false)
  assert.equal(withAta.rentLamports, 0n)
})

test('a SOL send to your own address and a zero amount are refused before any RPC call', async () => {
  const signer = Keypair.generate()
  const connection = fakeConnection(0)
  await assert.rejects(
    () => sendSol(connection, signer, signer.publicKey.toBase58(), 1_000n),
    /본인 주소/,
  )
  await assert.rejects(() => sendSol(connection, signer, Keypair.generate().publicKey.toBase58(), 0n), /수량/)
  await assert.rejects(() => sendSplToken(connection, signer, USDC, signer.publicKey.toBase58(), 1n, 6), /본인 주소/)
  await assert.rejects(
    () => sendSplToken(connection, signer, USDC, Keypair.generate().publicKey.toBase58(), 0n, 6),
    /수량/,
  )
})

test('an invalid recipient address never reaches signing', async () => {
  const signer = Keypair.generate()
  await assert.rejects(() => sendSol(fakeConnection(1_000_000), signer, 'not-an-address', 1_000n))
  await assert.rejects(() => sendSol(fakeConnection(1_000_000), signer, '1'.repeat(44), 1_000n))
})

function systemAccount(address: PublicKey, lamports: number) {
  return {
    executable: false,
    owner: SystemProgram.programId,
    lamports,
    data: Buffer.alloc(0),
    rentEpoch: 0,
  }
}

function tokenAccount(address: PublicKey, mint: PublicKey, amount: bigint, lamports: number) {
  const data = Buffer.alloc(AccountLayout.span)
  AccountLayout.encode({
    mint,
    owner: address,
    amount,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: 1,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data)
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports, data, rentEpoch: 0 }
}

function simulationAccount(info: ReturnType<typeof systemAccount> | ReturnType<typeof tokenAccount> | null) {
  if (!info) return null
  return {
    executable: info.executable,
    owner: info.owner.toBase58(),
    lamports: info.lamports,
    data: [info.data.toString('base64'), 'base64'],
    rentEpoch: info.rentEpoch,
  }
}

function broadcastConnection(options: {
  status?: any
  height?: number
  failSend?: boolean
  failStatus?: boolean
  failSimulation?: boolean
  omitSimulationAccounts?: boolean
  omitSimulationLogs?: boolean
} = {}) {
  const calls: string[] = []
  let sentSignature = ''
  const blockhash = Keypair.generate().publicKey.toBase58()
  const connection = {
    getLatestBlockhash: async () => {
      calls.push('blockhash')
      return { blockhash, lastValidBlockHeight: 20 }
    },
    getFeeForMessage: async () => {
      calls.push('fee')
      return { context: { slot: 42 }, value: Number(BASE_FEE_LAMPORTS) }
    },
    getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
      calls.push('before')
      return {
        context: { slot: 42 },
        value: addresses.map((address, index) => index === 0 ? systemAccount(address, 1_000_000_000) : null),
      }
    },
    simulateTransaction: async (tx: any, config: any) => {
      calls.push('simulate')
      const instruction = TransactionMessage.decompile(tx.message).instructions.find((item) => item.programId.equals(SystemProgram.programId))
      const amount = instruction ? SystemInstruction.decodeTransfer(instruction).lamports : 0n
      const addresses = config.accounts.addresses.map((address: string) => new PublicKey(address))
      const accounts = addresses.map((address: PublicKey, index: number) => simulationAccount(
        index === 0
          ? systemAccount(address, 1_000_000_000 - Number(amount) - Number(BASE_FEE_LAMPORTS))
          : systemAccount(address, Number(amount)),
      ))
      return {
        context: { slot: 42 },
        value: {
          err: options.failSimulation ? { InstructionError: [0, 'Custom'] } : null,
          ...(options.omitSimulationAccounts ? {} : { accounts }),
          ...(options.omitSimulationLogs ? {} : { logs: [`Program ${SystemProgram.programId.toBase58()} invoke [1]`, `Program ${SystemProgram.programId.toBase58()} success`] }),
          unitsConsumed: 500,
        },
      }
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      calls.push('send')
      const signed = VersionedTransaction.deserialize(raw).signatures[0]
      assert.ok(signed, 'transaction must already be signed')
      sentSignature = bs58.encode(signed)
      if (options.failSend) throw new Error('RPC connection lost after request')
      return sentSignature
    },
    getSignatureStatuses: async (signatures: string[]) => {
      calls.push('status')
      assert.equal(signatures[0], sentSignature || signatures[0])
      if (options.failStatus) throw new Error('RPC unavailable')
      return { value: [options.status ?? null] }
    },
    getBlockHeight: async () => {
      calls.push('height')
      return options.height ?? 10
    },
  }
  return { connection: connection as any, calls, getSentSignature: () => sentSignature }
}

test('a signed SOL send is persisted before RPC broadcast and confirmed with the same signature', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ status: { err: null, confirmationStatus: 'confirmed' } })
  let persisted = false
  let terminal = false
  let savedSignature = ''
  const signature = await sendSol(
    fake.connection,
    signer,
    Keypair.generate().publicKey.toBase58(),
    25_000n,
    {
      onSigned: (attempt) => {
        persisted = true
        savedSignature = attempt.signature
        assert.equal(attempt.lastValidBlockHeight, 20)
      },
      onTerminal: () => {
        terminal = true
      },
    },
  )
  assert.equal(persisted, true)
  assert.equal(savedSignature, fake.getSentSignature())
  assert.equal(signature, savedSignature)
  assert.equal(terminal, true)
  assert.deepEqual(fake.calls, ['blockhash', 'fee', 'before', 'simulate', 'height', 'send', 'status'])
})

test('a pending-record write failure prevents any RPC broadcast', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ status: { err: null, confirmationStatus: 'confirmed' } })
  await assert.rejects(
    () =>
      sendSol(
        fake.connection,
        signer,
        Keypair.generate().publicKey.toBase58(),
        25_000n,
        { onSigned: () => { throw new Error('local persistence failed') } },
      ),
    /local persistence failed/,
  )
  assert.deepEqual(fake.calls, ['blockhash', 'fee', 'before', 'simulate', 'height'])
})

test('a lost RPC response with an unconfirmed signature stays pending and is not reported failed', async () => {
  const signer = Keypair.generate()
  const fake = broadcastConnection({ failSend: true, status: null, height: 10 })
  let terminal = false
  await assert.rejects(
    () =>
      sendSol(fake.connection, signer, Keypair.generate().publicKey.toBase58(), 25_000n, {
        onTerminal: () => { terminal = true },
      }),
    (error: unknown) => error instanceof TxOutcomeError && error.outcome === 'pending',
  )
  assert.ok(fake.getSentSignature())
  assert.equal(terminal, false)
  assert.deepEqual(fake.calls, ['blockhash', 'fee', 'before', 'simulate', 'height', 'send', 'status', 'height'])
})

test('processed failures are not treated as final; confirmed failures are terminal', async () => {
  const processed = {
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] }),
  } as any
  const confirmedFailure = {
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] }),
  } as any
  assert.equal(await inspectTransaction(processed, 'sig', 10), 'pending')
  assert.equal(await inspectTransaction(confirmedFailure, 'sig', 10), 'failed')
})

test('expired blockhash with no history is reported as unresolved expiry, not proof of non-inclusion', async () => {
  const fake = broadcastConnection({ status: null, height: 21 })
  assert.equal(await inspectTransaction(fake.connection, 'unknown-signature', 20), 'expired')
})

test('RPC status lookup failure stays unknown', async () => {
  const fake = broadcastConnection({ failStatus: true })
  assert.equal(await inspectTransaction(fake.connection, 'unknown-signature', 10), 'unknown')
})

test('recent history merges and sorts signatures from the owner and token accounts', async () => {
  const owner = Keypair.generate().publicKey
  const tokenAccount = Keypair.generate().publicKey
  const olderTokenAccount = Keypair.generate().publicKey
  const queried: string[] = []
  const entry = (signature: string, slot: number) => ({
    signature,
    slot,
    blockTime: null,
    err: null,
    memo: null,
  })
  const fake = {
    getSignaturesForAddress: async (address: PublicKey) => {
      const key = address.toBase58()
      queried.push(key)
      if (key === owner.toBase58()) return [entry('owner-signature', 9), entry('shared-signature', 7)]
      if (key === tokenAccount.toBase58()) return [entry('token-signature', 8), entry('shared-signature', 10)]
      if (key === olderTokenAccount.toBase58()) return [entry('older-token-signature', 4)]
      return []
    },
    getParsedTransaction: async () => null,
  } as any

  const items = await fetchHistory(fake, owner.toBase58(), 3, [tokenAccount.toBase58(), olderTokenAccount.toBase58()])
  assert.deepEqual(new Set(queried), new Set([owner.toBase58(), tokenAccount.toBase58(), olderTokenAccount.toBase58()]))
  assert.deepEqual(items.map((item) => item.signature), ['shared-signature', 'owner-signature', 'token-signature'])
  assert.equal(items[0].slot, 10)
})

test('SOL preparation previews exact requested recipient amount, fee, and wallet delta without signing', async () => {
  const signer = Keypair.generate()
  const recipient = Keypair.generate().publicKey
  const fake = broadcastConnection()
  const prepared = await prepareSolSend(fake.connection, signer, recipient.toBase58(), 25_000n)
  assert.equal(prepared.preview.recipient, recipient.toBase58())
  assert.equal(prepared.preview.feeLamports, Number(BASE_FEE_LAMPORTS))
  assert.equal(prepared.preview.nativeChanges.find((change) => change.address === signer.publicKey.toBase58())?.deltaLamports, '-30000')
  assert.equal(prepared.preview.nativeChanges.find((change) => change.address === recipient.toBase58())?.deltaLamports, '25000')
  assertMessageMatches(prepared.transaction, prepared.messageBytes)
  assert.deepEqual(fake.calls, ['blockhash', 'fee', 'before', 'simulate'])
})

test('SPL preparation displays simulated ATA rent rather than relying on a fixed estimate', async () => {
  const signer = Keypair.generate()
  const recipient = Keypair.generate().publicKey
  const mint = new PublicKey(USDC)
  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey)
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient)
  const mintData = Buffer.alloc(MintLayout.span)
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: 1_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, mintData)
  const blockhash = Keypair.generate().publicKey.toBase58()
  const calls: string[] = []
  const fake = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data: mintData, rentEpoch: 0 }
      if (address.equals(destinationAta)) return null
      throw new Error('unexpected account lookup')
    },
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 50 }),
    getFeeForMessage: async () => ({ context: { slot: 77 }, value: 5_000 }),
    getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => ({
      context: { slot: 77 },
      value: addresses.map((address) => {
        if (address.equals(signer.publicKey)) return systemAccount(address, 1_000_000_000)
        if (address.equals(sourceAta)) return tokenAccount(signer.publicKey, mint, 1_000_000n, 2_039_280)
        if (address.equals(destinationAta)) return null
        return null
      }),
    }),
    simulateTransaction: async (_tx: unknown, config: any) => {
      calls.push('simulate')
      const addresses = config.accounts.addresses.map((address: string) => new PublicKey(address))
      const accounts = addresses.map((address: PublicKey) => {
        if (address.equals(signer.publicKey)) return simulationAccount(systemAccount(address, 1_000_000_000 - 5_000 - 2_039_280))
        if (address.equals(sourceAta)) return simulationAccount(tokenAccount(signer.publicKey, mint, 500_000n, 2_039_280))
        if (address.equals(destinationAta)) return simulationAccount(tokenAccount(recipient, mint, 500_000n, 2_039_280))
        return null
      })
      return {
        context: { slot: 77 },
        value: {
          err: null,
          accounts,
          logs: [
            'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]',
            'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
          ],
          unitsConsumed: 1_000,
        },
      }
    },
  } as any
  const prepared = await prepareSplSend(fake, signer, USDC, recipient.toBase58(), 500_000n, 6)
  assert.equal(prepared.rentLamports, BigInt(2_039_280))
  assert.equal(prepared.preview.tokenChanges.find((change) => change.owner === signer.publicKey.toBase58())?.deltaAmount, '-500000')
  assert.equal(prepared.preview.tokenChanges.find((change) => change.owner === recipient.toBase58())?.deltaAmount, '500000')
  assert.equal(prepared.preview.nativeChanges[0].deltaLamports, '-2044280')
  assert.deepEqual(calls, ['simulate'])
})

test('simulation errors or missing result data fail before any signature or broadcast', async () => {
  const signer = Keypair.generate()
  const recipient = Keypair.generate().publicKey.toBase58()
  for (const options of [{ failSimulation: true }, { omitSimulationAccounts: true }, { omitSimulationLogs: true }]) {
    const fake = broadcastConnection(options)
    await assert.rejects(() => prepareSolSend(fake.connection, signer, recipient, 25_000n))
    assert.equal(fake.calls.includes('send'), false)
    assert.equal(fake.calls.includes('status'), false)
  }
})

test('a changed message is rejected before sign or send', async () => {
  const signer = Keypair.generate()
  const recipient = Keypair.generate().publicKey.toBase58()
  const fake = broadcastConnection()
  const prepared = await prepareSolSend(fake.connection, signer, recipient, 25_000n)
  let signCalls = 0
  prepared.transaction.sign = () => { signCalls += 1 }
  prepared.transaction.message.compiledInstructions[0].data[0] ^= 1
  await assert.rejects(() => signPreparedSend(fake.connection, prepared, signer), /미리보기와 서명할 트랜잭션이 다릅니다/)
  assert.equal(signCalls, 0)
  assert.equal(fake.calls.includes('send'), false)
})

test('send preview is bound to the same wallet and expires by age or block height', async () => {
  const signer = Keypair.generate()
  const recipient = Keypair.generate().publicKey.toBase58()
  const fake = broadcastConnection()
  const prepared = await prepareSolSend(fake.connection, signer, recipient, 25_000n)
  let signCalls = 0
  prepared.transaction.sign = () => { signCalls += 1 }
  await assert.rejects(
    () => signPreparedSend(fake.connection, prepared, Keypair.generate()),
    /미리보기 당시 지갑과 현재 지갑이 다릅니다/,
  )
  assert.equal(signCalls, 0)

  prepared.createdAt = Date.now() - PREVIEW_TTL_MS - 1
  await assert.rejects(() => signPreparedSend(fake.connection, prepared, signer), /미리보기가 오래되어 만료됐습니다/)
  assert.equal(signCalls, 0)

  prepared.createdAt = Date.now()
  prepared.lastValidBlockHeight = 9
  await assert.rejects(() => signPreparedSend(fake.connection, prepared, signer), /블록해시가 만료됐습니다/)
  assert.equal(signCalls, 0)
  assert.equal(fake.calls.includes('send'), false)
})

test('history detail lookup failures preserve signature rows and successful details parse balances', async () => {
  const owner = Keypair.generate().publicKey
  const connection = {
    getSignaturesForAddress: async () => [
      { signature: 'signature-detail-unavailable', slot: 9, blockTime: null, err: null, memo: null },
      { signature: 'signature-detail-available', slot: 8, blockTime: 1_700_000_000, err: null, memo: 'sent' },
    ],
    getParsedTransaction: async (signature: string) => {
      if (signature === 'signature-detail-unavailable') throw new Error('RPC detail timeout')
      return {
        transaction: { message: { accountKeys: [owner] } },
        meta: {
          preBalances: [100_000],
          postBalances: [125_000],
          preTokenBalances: [],
          postTokenBalances: [{
            accountIndex: 1,
            mint: USDC,
            owner: owner.toBase58(),
            uiTokenAmount: { amount: '1250000', decimals: 6 },
          }],
        },
      }
    },
  } as any
  const history = await fetchHistory(connection, owner.toBase58(), 2)
  assert.equal(history.length, 2)
  assert.equal(history[0].signature, 'signature-detail-unavailable')
  assert.equal(history[0].detailed, false)
  assert.equal(history[0].solDelta, 0)
  assert.equal(history[1].detailed, true)
  assert.equal(history[1].solDelta, 25_000)
  assert.deepEqual(history[1].tokenDeltas, [{ mint: USDC, amount: '1250000', decimals: 6, uiAmount: 1.25 }])
})
