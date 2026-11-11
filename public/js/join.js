// join.html: forwards an invite link to the iPhone app (D-58).
(function () {
  // The public TestFlight link, once there is one. Empty means "not yet":
  // step 1 then says to ask for the TestFlight invite, and shows no button.
  const TESTFLIGHT_URL = '';

  const $ = (id) => document.getElementById(id);
  const token = (location.hash || '').slice(1).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) {
    $('ready').hidden = true;
    $('broken').hidden = false;
    return;
  }

  $('open-app').href = 'pickleballers://join/' + token;

  if (TESTFLIGHT_URL) {
    $('get-app').href = TESTFLIGHT_URL;
    $('get-app').hidden = false;
    $('testflight-note').textContent = "It's in TestFlight for now.";
  }

  // No automatic redirect: without the app, Safari would show an "invalid
  // address" alert, and with it Safari asks before opening the app anyway.
  // A tap that opens nothing (no app, so the page is still here a moment
  // later) points at the steps instead of leaving the person at a dead end.
  let waiting = null;
  $('open-app').addEventListener('click', () => {
    clearTimeout(waiting);
    waiting = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      $('no-app').hidden = false;
      const steps = $('steps');
      steps.classList.remove('nudge');
      void steps.offsetWidth;
      steps.classList.add('nudge');
      steps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 2500);
  });
  // The app opened: the page went to the background, so nothing to point at.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(waiting);
      $('no-app').hidden = true;
    }
  });

  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('copied').hidden = false;
    } catch (e) {
      window.prompt('Copy this link:', location.href);
    }
  });
})();
