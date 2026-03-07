/**
 * CLIENT - connection introspection (SETNAME, GETNAME, ID).
 * Requires connection context.
 */

function argStr(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

export function handleClient(engine, args, context) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'CLIENT\' command' };
  }
  const sub = argStr(args[0]).toUpperCase();
  if (sub === 'SETNAME') {
    if (args.length !== 2) {
      return { error: 'ERR wrong number of arguments for \'CLIENT SETNAME\' command' };
    }
    context.connectionName = argStr(args[1]);
    return { simple: 'OK' };
  }
  if (sub === 'GETNAME') {
    if (args.length !== 1) {
      return { error: 'ERR wrong number of arguments for \'CLIENT GETNAME\' command' };
    }
    return context.connectionName ?? null;
  }
  if (sub === 'ID') {
    if (args.length !== 1) {
      return { error: 'ERR wrong number of arguments for \'CLIENT ID\' command' };
    }
    return context.connectionId;
  }
  return { error: 'ERR unknown subcommand or wrong number of arguments for \'CLIENT\'. Try CLIENT HELP.' };
}
