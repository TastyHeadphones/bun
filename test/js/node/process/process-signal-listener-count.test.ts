import type { Subprocess } from "bun";
import { dlopen } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isDebug, isLinux, isWindows, libcPathForDlopen, normalizeBunSnapshot } from "harness";
import { constants } from "node:os";

// When multiple listeners are registered for the same signal, removing one
// listener must NOT uninstall the underlying OS signal handler while other
// listeners remain.
test.skipIf(isWindows)("removing one of multiple signal listeners keeps the handler installed", async () => {
  const script = /*js*/ `
    const { promise, resolve } = Promise.withResolvers();

    let handlerBCount = 0;

    function handlerA() {
      console.log("handlerA fired (bug: I was removed!)");
    }

    function handlerB() {
      handlerBCount++;
      console.log("handlerB fired", handlerBCount);
      if (handlerBCount === 2) {
        resolve();
      }
    }

    process.on("SIGUSR2", handlerA);
    process.on("SIGUSR2", handlerB);

    // Remove handlerA - handlerB should still receive signals.
    process.off("SIGUSR2", handlerA);

    // Send ourselves the signal twice.
    process.kill(process.pid, "SIGUSR2");

    // Wait for first signal, then send again.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    process.kill(process.pid, "SIGUSR2");

    await promise;
    console.log("done");
  `;

  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toBe("");
  expect(normalizeBunSnapshot(stdout)).toMatchInlineSnapshot(`
"handlerB fired 1
handlerB fired 2
done"
`);
  expect(exitCode).toBe(0);
});

// Verify that removing ALL listeners does properly uninstall the handler,
// so the process dies with the default signal behavior.
test.skipIf(isWindows)("removing all signal listeners uninstalls the handler (default signal behavior)", async () => {
  const script = /*js*/ `
    function handlerA() {}
    function handlerB() {}

    process.on("SIGUSR2", handlerA);
    process.on("SIGUSR2", handlerB);

    process.off("SIGUSR2", handlerA);
    process.off("SIGUSR2", handlerB);

    // Keep event loop alive briefly so signal can be delivered
    setTimeout(() => {
      // If we get here, the signal handler was incorrectly still installed
      // (or signal was ignored). Exit with a distinct code.
      process.exit(42);
    }, 1000);

    process.kill(process.pid, "SIGUSR2");
  `;

  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stdout).toBe("");
  // Default SIGUSR2 behavior is to terminate the process with a signal.
  // If the handler was correctly uninstalled, the process dies via signal (not exit code 42).
  expect(exitCode).not.toBe(42);
  expect(exitCode).not.toBe(0);
  expect(proc.signalCode).not.toBeNull();
});

// Re-adding a listener after all were removed should reinstall the handler.
test.skipIf(isWindows)("re-adding a listener after removing all reinstalls the handler", async () => {
  const script = /*js*/ `
    const { promise, resolve } = Promise.withResolvers();

    function handlerA() {}
    function handlerB() {
      console.log("handlerB fired");
      resolve();
    }

    process.on("SIGUSR2", handlerA);
    process.off("SIGUSR2", handlerA);
    process.on("SIGUSR2", handlerB);

    process.kill(process.pid, "SIGUSR2");
    await promise;
    console.log("done");
  `;

  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toBe("");
  expect(normalizeBunSnapshot(stdout)).toMatchInlineSnapshot(`
"handlerB fired
done"
`);
  expect(exitCode).toBe(0);
});

// On Linux, JSC suspends and resumes threads with SIGPWR, and it keeps the sigaction for the
// process lifetime. A SIGPWR that JSC did not send used to reach its handler, which then read a
// null Thread* ("Segmentation fault at address 0x60"). Such a delivery now goes to the
// process.on("SIGPWR") listeners, and adding or removing a listener leaves the sigaction alone.
describe.skipIf(!isLinux)("SIGPWR", () => {
  const SIGPWR = constants.signals.SIGPWR;

  async function run(script: string, env: Record<string, string> = {}) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: { ...bunEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode, signalCode: proc.signalCode };
  }

  const exitedCleanly = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, signalCode: null });

  // BUN_JSC_collectContinuously runs collections on the collector thread, which suspends and
  // resumes the main thread with SIGPWR for every stack scan. The loop cannot finish unless
  // those deliveries still reach JSC while the ones from kill(2) reach the listener.
  const listenerCallsUnderGC = (iterations: number) => /*js*/ `
    let calls = 0;
    let onCall;
    process.on("SIGPWR", () => {
      calls++;
      onCall();
    });
    for (let i = 0; i < ${iterations}; i++) {
      const garbage = [];
      for (let j = 0; j < 200; j++) garbage.push({ j, text: Buffer.alloc(64, "a").toString() });
      Bun.gc(true);
      const { promise, resolve } = Promise.withResolvers();
      onCall = resolve;
      process.kill(process.pid, ${SIGPWR});
      await promise;
    }
    console.log(calls);
  `;
  const iterations = isDebug ? 10 : 50;

  test.concurrent.each([SIGPWR, "SIGPWR"])("process.kill(process.pid, %p) runs the listener", async signal => {
    const script = /*js*/ `
      const { promise, resolve } = Promise.withResolvers();
      process.on("SIGPWR", (name, number) => {
        console.log("listener", name, number);
        resolve();
      });
      process.kill(process.pid, ${JSON.stringify(signal)});
      await promise;
      console.log("alive");
    `;
    expect(await run(script)).toEqual(exitedCleanly(`listener SIGPWR ${SIGPWR}\nalive\n`));
  });

  // The main thread's tid is the pid.
  function tgkill(pid: number, signal: number) {
    const libc = dlopen(libcPathForDlopen(), { syscall: { args: ["i64", "i32", "i32", "i32"], returns: "i64" } });
    try {
      const SYS_tgkill = process.arch === "x64" ? 234 : 131;
      expect(libc.symbols.syscall(SYS_tgkill, pid, pid, signal)).toBe(0n);
    } finally {
      libc.close();
    }
  }

  test.concurrent.each([
    // By number, so that the parent does not need "SIGPWR" in its own name table.
    ["process.kill(pid, SIGPWR)", (proc: Subprocess) => void process.kill(proc.pid, SIGPWR)],
    ['subprocess.kill("SIGPWR")', (proc: Subprocess) => proc.kill("SIGPWR")],
    // SI_TKILL, like JSC's own pthread_kill. Only si_pid shows that JSC did not send it.
    ["tgkill(2)", (proc: Subprocess) => tgkill(proc.pid, SIGPWR)],
  ])("%s from another process runs the listener", async (_, send) => {
    const script = /*js*/ `
      const { promise, resolve } = Promise.withResolvers();
      process.on("SIGPWR", (name, number) => {
        console.log("listener", name, number);
        resolve();
      });
      console.log("ready");
      await promise;
      console.log("alive");
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderrText = proc.stderr.text();
    const decoder = new TextDecoder();
    let stdout = "";
    let sent = false;
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      if (!sent && stdout.includes("ready\n")) {
        sent = true;
        send(proc);
      }
    }
    const [stderr, exitCode] = await Promise.all([stderrText, proc.exited]);
    expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual(
      exitedCleanly(`ready\nlistener SIGPWR ${SIGPWR}\nalive\n`),
    );
  });

  // Node terminates here, because the default action of SIGPWR applies. Bun cannot restore
  // SIG_DFL for a signal that JSC depends on, so it ignores the delivery.
  test.concurrent("SIGPWR without a listener is ignored", async () => {
    const script = /*js*/ `
      process.kill(process.pid, ${SIGPWR});
      await new Promise(resolve => setImmediate(resolve));
      console.log("alive");
    `;
    expect(await run(script)).toEqual(exitedCleanly("alive\n"));
  });

  test.concurrent("JSC still suspends and resumes threads while a listener is installed", async () => {
    const result = await run(listenerCallsUnderGC(iterations), { BUN_JSC_collectContinuously: "1" });
    expect(result).toEqual(exitedCleanly(`${iterations}\n`));
  });

  test.concurrent("removing the last listener keeps JSC's handler installed", async () => {
    const script = /*js*/ `
      const listener = () => {};
      process.on("SIGPWR", listener);
      process.off("SIGPWR", listener);
      ${listenerCallsUnderGC(iterations)}
    `;
    expect(await run(script, { BUN_JSC_collectContinuously: "1" })).toEqual(exitedCleanly(`${iterations}\n`));
  });
});
