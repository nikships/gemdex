export function remoteOptionLabel(remote) {
  return `${remote.name} · ${remote.url}${remote.hasToken ? "" : " · token missing"}`;
}

export function connectionStatus(name, result) {
  if (result.reachable && result.authenticated) {
    return {
      text: `${name} is reachable and authenticated.`,
      isError: false,
    };
  }
  return {
    text: result.detail || `${name} could not be authenticated.`,
    isError: true,
  };
}

export function migrationStatus(result) {
  return {
    text: `Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
    isError: result.skipped > 0,
  };
}
