/*
 * Browser-side extractor for the Garage Hive Community welcome posts.
 *
 * Not a Node script -- paste this into the devtools console (or run it through the
 * Playwright MCP's browser_evaluate) while sitting on:
 *   https://www.facebook.com/groups/1808538692573390/search/?q=welcome
 *
 * Turn the sidebar's "Most recent" toggle ON and set "Date posted" to the window you
 * want first. We deliberately do NOT parse post dates: Facebook interleaves U+034F and
 * zero-width characters through the timestamp, so its DOM text is garbage even though it
 * renders correctly on screen. Bounding the run with their own filters is both simpler
 * and more reliable than trying to unscramble it.
 *
 * Copy the JSON it returns into a file and feed that to gh-prospects.cjs.
 */
(async () => {
  const SCROLLS = 8;
  const PAUSE_MS = 1600;

  // Facebook sprays hidden decoy text ("Facebook Facebook Facebook...") and zero-width
  // characters through post markup to poison exactly this kind of extraction.
  const strip = (s) =>
    (s || '')
      .replace(/[͏​-‏⁠﻿]/g, '')
      .replace(/(?:\bFacebook\b\s*)+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = new Map();

  const harvest = () => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return;
    for (const card of feed.children) {
      // role="article" matches COMMENTS, not posts -- the real posts are the feed's own
      // children. Comments carry aria-label="Comment by ...", posts do not.
      const h = card.querySelector('h3, h2 strong, span strong');
      const author = strip(h ? h.innerText : '');
      const blocks = Array.from(card.querySelectorAll('div[dir="auto"]'))
        .map((b) => strip(b.innerText))
        .filter((t) => t.length > 40);
      if (!blocks.length) continue;
      const body = blocks.sort((x, y) => y.length - x.length)[0];
      if (!seen.has(body)) seen.set(body, { author, body });
    }
  };

  harvest();
  for (let i = 0; i < SCROLLS; i++) {
    window.scrollBy(0, window.innerHeight * 2);
    await sleep(PAUSE_MS);
    harvest();
  }

  const posts = Array.from(seen.values());
  console.log(JSON.stringify(posts, null, 2));
  return posts;
})();
