import CDP from "chrome-remote-interface";
import * as fs from "fs";

(async () => {
  const res = await fetch("http://localhost:18800/json");
  const pages = (await res.json()) as any[];
  const target = pages.find((p: any) => p.type === "page" && p.webSocketDebuggerUrl);
  const client = await CDP({ target: target!.webSocketDebuggerUrl });
  await client.Page.enable();
  await client.Runtime.enable();

  await new Promise(r => setTimeout(r, 2000));

  // Strategy: use innerHTML and regex to find img positions relative to text
  // First get the content div's innerHTML
  const { result: htmlResult } = await client.Runtime.evaluate({
    expression: `(function() {
      var article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;
      
      var allDivs = article.querySelectorAll('div');
      var contentDiv = null;
      for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        if (d.querySelectorAll('h1').length >= 3 && d.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length >= 5) {
          contentDiv = d;
          break;
        }
      }
      if (!contentDiv) return null;
      
      // Get the inner HTML length to check feasibility
      var html = contentDiv.innerHTML;
      return JSON.stringify({
        htmlLength: html.length,
        mediaCount: (html.match(/pbs\\.twimg\\.com\\/media\\//g) || []).length,
        // Also try a different approach: iterate all nodes in tree order
        totalChildNodes: contentDiv.querySelectorAll('*').length
      });
    })()`
  });
  console.log("HTML check:", (htmlResult as any).value);

  // Better approach: use TreeWalker to visit ALL nodes in document order
  const { result: walkResult } = await client.Runtime.evaluate({
    expression: `(function() {
      var article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;
      
      // Find the content wrapper that contains all the article content
      // Skip user name, timestamp, action buttons
      var allDivs = article.querySelectorAll('div');
      var contentDiv = null;
      for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        if (d.querySelectorAll('h1').length >= 3 && d.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length >= 5) {
          contentDiv = d;
          break;
        }
      }
      if (!contentDiv) return null;
      
      var imgIdx = 0;
      var blocks = [];
      var textBuffer = '';
      
      // TreeWalker visits all nodes in document order
      var walker = document.createTreeWalker(contentDiv, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          var tag = node.tagName.toLowerCase();
          // Skip hidden elements
          if (node.offsetParent === null && tag !== 'img') {
            // But check a few more...
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      
      var node;
      var visitedTags = {};
      while (node = walker.nextNode()) {
        var tag = node.tagName.toLowerCase();
        
        // Headings
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
          flushText();
          var level = tag === 'h1' ? '#' : tag === 'h2' ? '##' : '###';
          blocks.push({type: 'heading', level: level, text: node.textContent.trim()});
          continue;
        }
        
        // Code blocks
        if (tag === 'pre') {
          flushText();
          blocks.push({type: 'code', text: node.textContent.trim()});
          continue;
        }
        
        // Lists
        if (tag === 'ul' || tag === 'ol') {
          flushText();
          var items = [];
          node.querySelectorAll(':scope > li').forEach(function(li) {
            items.push(li.textContent.trim());
          });
          blocks.push({type: 'list', ordered: tag === 'ol', items: items});
          continue;
        }
        
        // Images
        if (tag === 'img') {
          var src = node.getAttribute('src') || '';
          if (src.includes('pbs.twimg.com/media/')) {
            flushText();
            imgIdx++;
            blocks.push({type: 'image', index: imgIdx});
          }
          continue;
        }
        
        // Blockquotes
        if (tag === 'blockquote') {
          flushText();
          blocks.push({type: 'quote', text: node.textContent.trim()});
          continue;
        }
      }
      flushText();
      
      function flushText() {
        if (textBuffer.trim()) {
          blocks.push({type: 'text', text: textBuffer.trim()});
          textBuffer = '';
        }
      }
      
      return JSON.stringify({totalBlocks: blocks.length, imageCount: imgIdx, blocks: blocks});
    })()`
  });

  const parsed = JSON.parse((walkResult as any).value);
  fs.writeFileSync("test-walk.json", JSON.stringify(parsed, null, 2), "utf-8");
  console.log("\nWalk result:", parsed.totalBlocks, "blocks,", parsed.imageCount, "images");
  parsed.blocks.slice(0, 30).forEach((b: any, i: number) => {
    if (b.type === 'image') console.log(`  ${i}: 🖼️ IMAGE #${b.index}`);
    else if (b.type === 'heading') console.log(`  ${i}: ${b.level} ${b.text.substring(0, 60)}`);
    else if (b.type === 'code') console.log(`  ${i}: \`\`\` ${b.text.substring(0, 40)}...`);
    else if (b.type === 'list') console.log(`  ${i}: LIST (${b.items.length} items)`);
    else console.log(`  ${i}: TEXT ${b.text.substring(0, 60)}...`);
  });

  await client.close();
})();
