import CDP from "chrome-remote-interface";
import * as fs from "fs";

(async () => {
  const res = await fetch("http://localhost:18800/json");
  const pages = (await res.json()) as any[];
  const target = pages.find((p: any) => p.type === "page" && p.webSocketDebuggerUrl);
  const client = await CDP({ target: target!.webSocketDebuggerUrl });
  await client.Page.enable();
  await client.Runtime.enable();

  await client.Page.navigate({ url: "https://x.com/HiTw93/status/2032091246588518683" });
  await new Promise(r => setTimeout(r, 8000));

  // Scroll to load all content
  for (let i = 0; i < 15; i++) {
    await client.Runtime.evaluate({ expression: "window.scrollBy(0, 1500)" });
    await new Promise(r => setTimeout(r, 2000));
  }
  // Scroll back to top
  await client.Runtime.evaluate({ expression: "window.scrollTo(0, 0)" });
  await new Promise(r => setTimeout(r, 1000));

  // Extract structured content with image positions
  const { result } = await client.Runtime.evaluate({
    expression: `(function() {
      var article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return JSON.stringify({error: "no article"});

      // Walk through all top-level children of the article content area
      // X long-form articles use a specific structure
      var imgIndex = 0;
      var blocks = [];
      
      function walk(node, depth) {
        if (depth > 15) return;
        
        // Process headings
        var tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
          var text = node.textContent.trim();
          if (text && text.length > 0) {
            var prefix = tag === 'h1' ? '#' : tag === 'h2' ? '##' : '###';
            blocks.push({type: 'heading', level: prefix, text: text});
          }
          return;
        }
        
        // Process media images (NOT avatars)
        if (tag === 'img') {
          var src = node.getAttribute('src') || '';
          if (src.includes('pbs.twimg.com/media/') || src.includes('pbs.twimg.com/amplify_video_thumb/')) {
            imgIndex++;
            blocks.push({type: 'image', index: imgIndex, src: src.split('?')[0]});
          }
          return;
        }
        
        // Process text paragraphs
        if (tag === 'p' || tag === 'div') {
          // Check if this node has direct text content (not just from children)
          var directText = '';
          var hasMediaImg = false;
          var hasBlockChild = false;
          
          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            var childTag = child.tagName ? child.tagName.toLowerCase() : '';
            if (childTag === 'h1' || childTag === 'h2' || childTag === 'h3' || childTag === 'img') {
              hasBlockChild = true;
            }
            if (childTag === 'img' && (child.getAttribute('src') || '').includes('pbs.twimg.com/media/')) {
              hasMediaImg = true;
            }
          }
          
          if (hasBlockChild) {
            // Just walk children
            for (var j = 0; j < node.children.length; j++) {
              walk(node.children[j], depth + 1);
            }
            return;
          }
          
          var text = node.textContent.trim();
          if (text && text.length > 0 && !hasMediaImg) {
            // Check if parent already captured this
            blocks.push({type: 'text', text: text});
            return;
          }
          if (hasMediaImg) {
            // This div contains an image, extract image
            var imgs = node.querySelectorAll('img');
            imgs.forEach(function(img) {
              var s = img.getAttribute('src') || '';
              if (s.includes('pbs.twimg.com/media/') || s.includes('pbs.twimg.com/amplify_video_thumb/')) {
                imgIndex++;
                blocks.push({type: 'image', index: imgIndex, src: s.split('?')[0]});
              }
            });
            // Also get any text before/after
            var remaining = node.textContent.trim();
            if (remaining && remaining.length > 0) {
              // Check if it's just alt text
              var altTexts = [];
              imgs.forEach(function(img) { altTexts.push(img.getAttribute('alt') || ''); });
              var cleanText = remaining;
              altTexts.forEach(function(alt) {
                if (alt) cleanText = cleanText.replace(alt, '');
              });
              cleanText = cleanText.trim();
              if (cleanText.length > 0) {
                blocks.push({type: 'text', text: cleanText});
              }
            }
            return;
          }
        }
        
        // Recurse into children
        for (var k = 0; k < node.children.length; k++) {
          walk(node.children[k], depth + 1);
        }
      }
      
      // Get the article body, skip the header (User-Name, timestamp, action bar)
      // The content starts after the engagement bar area
      var contentStart = article.querySelector('[data-testid="tweetText"]');
      var contentRoot = contentStart ? contentStart.closest('[role="blockquote"], [data-testid="tweet"], div') || article : article;
      
      // Actually, for X articles, the whole thing is in article
      // We need to find the tweet text container
      // It's typically the div containing h1/h2/p/img elements
      
      walk(contentRoot, 0);
      
      return JSON.stringify({totalBlocks: blocks.length, imageCount: imgIndex, blocks: blocks.slice(0, 50)}, null, 2);
    })()`
  });
  const output = (result as any).value;
  fs.writeFileSync("test-structure.json", output, "utf-8");
  console.log("Saved to test-structure.json");
  console.log("Preview:", output.substring(0, 2000));

  await client.close();
})();
