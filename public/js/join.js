// join.html: forwards an invite link to the iPhone app (D-58).
(function () {
  const token = (location.hash || '').slice(1).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) {
    document.getElementById('ready').style.display = 'none';
    document.getElementById('broken').style.display = '';
    return;
  }

  const appLink = 'pickleballers://join/' + token;
  document.getElementById('open-app').href = appLink;

  document.getElementById('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      document.getElementById('copied').style.display = '';
    } catch (e) {
      window.prompt('Copy this link:', location.href);
    }
  });

  // No automatic redirect: without the app, Safari would show an "invalid
  // address" alert, and with it Safari asks before opening the app anyway.
})();
