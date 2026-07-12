export function createTerrainFetchScheduler({
  execute,
  initialPass = 1,
  pollMs = 3000,
  scheduleFrame = callback => requestAnimationFrame(callback),
  schedulePoll = (callback, delay) => setTimeout(callback, delay),
  cancelPoll = timer => clearTimeout(timer),
  onSkip = () => {},
  onError = () => {},
  onState = () => {},
  onPreviewComplete = () => {},
  onPoll = () => {},
  onSettled = () => {},
}) {
  let pass = initialPass;
  let fetching = false;
  let pollTimer = null;
  let generation = 0;
  let activeController = null;

  const emitState = () => onState({ pass, fetching });

  async function request(lat, lon) {
    if (fetching) {
      onSkip();
      return;
    }
    fetching = true;
    const requestGeneration = generation;
    activeController = new AbortController();
    emitState();
    try {
      const result = await execute({ lat, lon, pass, signal: activeController.signal });
      if (requestGeneration !== generation) return;
      activeController = null;
      if (pollTimer != null) {
        cancelPoll(pollTimer);
        pollTimer = null;
      }
      if (result.nextAction === 'full-pass') {
        fetching = false;
        pass = 2;
        emitState();
        onPreviewComplete(result);
        scheduleFrame(() => request());
        return;
      }
      if (result.nextAction === 'poll') {
        pollTimer = schedulePoll(() => {
          pollTimer = null;
          onPoll();
          request();
        }, pollMs);
      }
    } catch (error) {
      if (requestGeneration !== generation || error?.name === 'AbortError') return;
      onError(error);
    }
    activeController = null;
    fetching = false;
    emitState();
    onSettled();
  }

  function reset(nextPass = 1) {
    generation += 1;
    activeController?.abort();
    activeController = null;
    if (pollTimer != null) cancelPoll(pollTimer);
    pollTimer = null;
    pass = nextPass;
    fetching = false;
    emitState();
  }

  emitState();
  return { request, reset, get pass() { return pass; }, get fetching() { return fetching; } };
}
