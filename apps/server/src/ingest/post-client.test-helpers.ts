// Task 2.7, clause C1: a one-shot hook client run in its own node process
// (`node post-client.test-helpers.ts <url> <token> <body>`). It times the round trip on its own
// clock and prints `{ status, body, ms }` as JSON, so the test can tell a reply sent before
// processing from one sent after, even while the server's process is blocked.
const [url, token, body] = process.argv.slice(2);

async function main(): Promise<void> {
  if (url === undefined || token === undefined || body === undefined) {
    process.stdout.write(JSON.stringify({ error: 'usage: <url> <token> <body>' }));
    return;
  }
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  process.stdout.write(JSON.stringify({ status: response.status, body: text, ms }));
}

await main();

export {};
