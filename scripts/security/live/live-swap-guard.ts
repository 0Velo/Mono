/**
 * Live Jupiter guard check (mainnet read-only).
 *
 * Asks the real Jupiter API for a 0.01 SOL → USDC swap for a disposable,
 * unfunded keypair, then runs the same guard + simulation the app runs before
 * signing. Nothing is signed or broadcast: an unfunded key cannot swap, and
 * this test must never spend user funds.
 *
 * What this proves against reality (not a fixture):
 *   - the quote/tx endpoints still answer, and the tx deserializes;
 *   - the guard's program allowlist accepts what Jupiter actually returns
 *     (or reports exactly which program it would block);
 *   - address lookup tables, if used, resolve;
 *   - the simulation call works end to end (it is expected to fail with
 *     insufficient funds for an unfunded key — that is stated, not hidden).
 */
import { Connection, Keypair } from '@solana/web3.js'
import { USDC_MINT, WSOL_MINT, fetchSwapQuote, fetchSwapTransaction } from '../../../src/lib/swap'
import { assertSwapSimulation, assertSwapTransaction, SwapGuardError } from '../../../src/lib/swapGuard'
import { resolveLookupKeys } from '../../../src/lib/swapExecute'
import { VersionedTransaction } from '@solana/web3.js'
import { base64ToBytes } from '../../../src/lib/swap'

const RPC = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']

async function connect(): Promise<{ connection: Connection; url: string }> {
  let lastError: unknown = null
  for (const url of RPC) {
    const connection = new Connection(url, 'confirmed')
    try {
      await connection.getLatestBlockhash('confirmed')
      return { connection, url }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('mainnet rpc unreachable')
}

async function main() {
  const out: Record<string, unknown> = { status: 'UNVERIFIED', steps: [] as string[] }
  const steps = out.steps as string[]
  const { connection, url } = await connect()
  out.rpc = url
  const user = Keypair.generate()
  out.user = user.publicKey.toBase58()

  const quote = await fetchSwapQuote({
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    amount: '10000000',
    slippageBps: 50,
  })
  steps.push('quote')
  out.quote = {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    route: quote.route,
    base: quote.base,
  }

  const built = await fetchSwapTransaction(quote, user.publicKey.toBase58())
  steps.push('swap-transaction')
  const tx = VersionedTransaction.deserialize(base64ToBytes(built.transaction))
  out.lookupTables = (tx.message.addressTableLookups ?? []).length
  out.instructionCount = tx.message.compiledInstructions.length

  const keys = await resolveLookupKeys(connection, tx)
  steps.push('lookup-tables')
  const report = assertSwapTransaction(tx, user.publicKey.toBase58(), keys)
  steps.push('guard')
  out.guard = {
    verdict: 'PASS',
    programs: report.programs,
    requiredSigners: report.requiredSigners,
  }

  let simulation: any = null
  try {
    simulation = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })
    steps.push('simulate')
    out.simulation = {
      err: simulation.value?.err ?? null,
      logs: (simulation.value?.logs ?? []).slice(-6),
    }
  } catch (error) {
    steps.push('simulate-error')
    out.simulation = { error: String((error as Error)?.message ?? error).slice(0, 400) }
  }

  // The unfunded key is expected to fail on fees/balance. Any other error, or a
  // guard rejection, is a finding worth surfacing.
  if (simulation) {
    try {
      assertSwapSimulation(simulation, {
        owner: user.publicKey.toBase58(),
        inputMint: quote.inputMint,
        inAmount: quote.inAmount,
        outputMint: quote.outputMint,
        minOut: quote.otherAmountThreshold,
      })
      out.simulationVerdict = 'PASS'
      out.status = 'PASS'
    } catch (error) {
      const guardError = error instanceof SwapGuardError ? error : null
      out.simulationVerdict = guardError ? guardError.reason : 'ERROR'
      out.simulationError = String((error as Error)?.message ?? error).slice(0, 400)
      // An unfunded disposable key has no account at all: the cluster refusing
      // the swap is the expected, honest outcome and still proves the simulation
      // ran. A guard rejection (other than simulation-failed) is a real finding.
      const expected = /insufficient|no record of a prior credit|attempt to debit|AccountNotFound|InvalidAccountForFee|account.*not found/i.test(
        `${out.simulationError} ${JSON.stringify(simulation.value?.err ?? '')} ${(simulation.value?.logs ?? []).join(' ')}`,
      )
      out.status =
        guardError && guardError.reason !== 'simulation-failed'
          ? 'FAIL'
          : expected
            ? 'PASS (guard ok on a live Jupiter tx; unfunded key, simulation refused as expected)'
            : 'REVIEW'
    }
  } else {
    out.status = 'FAIL'
  }

  return out
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.log(
      JSON.stringify({
        status: 'UNVERIFIED',
        error: String((error as Error)?.message ?? error).slice(0, 600),
      }),
    )
  })
