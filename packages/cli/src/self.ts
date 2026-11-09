/** argv prefix that re-runs this CLI, whether it's a script run by Bun or a compiled binary. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  return script && /\.(c|m)?[jt]s$/.test(script) ? [process.execPath, script] : [process.execPath];
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}
