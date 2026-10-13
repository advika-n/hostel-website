(function () {
  var t = null;
  try { t = localStorage.getItem('hd-theme'); } catch (e) { /* storage can be blocked */ }
  if (t !== 'light' && t !== 'dark') {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
