export function remoteOptionLabel(remote) {
  return `${remote.name} · ${remote.url}${remote.hasToken ? "" : " · token missing"}`;
}

export function backendLabel(backend) {
  if (!backend) return "the current backend";
  if (backend.mode === "remote") {
    return backend.activeRemote?.name
      ? `remote backend “${backend.activeRemote.name}”`
      : "remote backend";
  }
  return backend.needsKey ? "local backend (needs API key)" : "local backend";
}

export function targetBackendLabel(mode, name = "") {
  if (mode === "remote") {
    return name ? `remote backend “${name}”` : "remote backend";
  }
  return "local backend";
}

export function shouldConfirmBackendSwitch(currentBackend, mode, name = "") {
  if (!currentBackend || currentBackend.mode !== mode) return true;
  if (mode !== "remote") return false;
  return (currentBackend.activeRemote?.name ?? "") !== name;
}

export function backendSwitchConfirmation(currentBackend, mode, name = "") {
  return `Switch from ${backendLabel(currentBackend)} to ${targetBackendLabel(mode, name)}?`;
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
