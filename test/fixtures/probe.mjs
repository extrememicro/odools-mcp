const mode = process.argv[2];
if (mode === "flood") process.stdout.write("x".repeat(100_000));
else if (mode === "flood-hang") { process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x".repeat(10_000)), 1); }
else if (mode === "nonzero") process.exit(7);
else if (mode === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else if (mode === "pipes") { const { spawn } = await import("node:child_process"); spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", process.stdout, process.stderr] }); }
else process.stdout.write("ok");
