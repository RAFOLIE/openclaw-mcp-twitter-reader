import CDP from "chrome-remote-interface";
import * as fs from "fs";

(async () => {
  const res = await fetch("http://localhost:18800/json");
  const pages = (await res.json()) as any[];
  const target = pages.find((p: any) => p.type === "page" && p.webSocketDebuggerUrl);
  const client = await CDP({ target: target!.webSocketDebuggerUrl });
  await client.Page.enable();
  await client.Runtime.enable();

  // Already on the page, just extract
  await new Promise(r => setTimeout(r, 2000));

  // First, find the article content container and understand its DOM tree
  const { result: domResult } = await client.Runtime.evaluate({
    expression: `(function() {
      var article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return JSON.stringify({error: "no article"});

      // Find the main content area - it's a specific div inside article
      // We look for divs that contain both h1 and img elements
      var allDivs = article.querySelectorAll('div');
      var contentDiv = null;
      for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        var h1s = d.querySelectorAll('h1');
        var imgs = d.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
        if (h1s.length >= 3 && imgs.length >= 5) {
          contentDiv = d;
          break;
        }
      }
      
      if (!contentDiv) return JSON.stringify({error: "content div not found"});
      
      // Get the direct children structure
      var children = [];
      for (var j = 0; j < contentDiv.children.length; j++) {
        var child = contentDiv.children[j];
        var tag = child.tagName.toLowerCase();
        var classes = child.className ? child.className.substring(0, 60) : '';
        var textLen = child.textContent ? child.textContent.trim().length : 0;
        var imgCount = child.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length;
        var hCount = child.querySelectorAll('h1,h2,h3,h4').length;
        children.push({tag: tag, classes: classes, textLen: textLen, imgCount: imgCount, hCount: hCount});
      }
      
      return JSON.stringify({
        contentDivFound: true,
        totalChildren: contentDiv.children.length,
        children: children.slice(0, 30),
        totalMedia: contentDiv.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length,
        totalH1: contentDiv.querySelectorAll('h1').length
      }, null, 2);
    })()`
  });
  console.log("DOM structure:");
  console.log((domResult as any).value);

  // Now try a different approach: use the content div's innerHTML 
  // to reconstruct markdown with images in correct positions
  const { result: mdResult } = await client.Runtime.evaluate({
    expression: `(function() {
      var article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;
      
      var allDivs = article.querySelectorAll('div');
      var contentDiv = null;
      for (var i = 0; i < allDivs.length; i++) {
        var d = allDivs[i];
        var h1s = d.querySelectorAll('h1');
        var imgs = d.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
        if (h1s.length >= 3 && imgs.length >= 5) {
          contentDiv = d;
          break;
        }
      }
      if (!contentDiv) return null;
      
      // Walk direct children of contentDiv to build blocks
      var imgIdx = 0;
      var blocks = [];
      
      function processNode(node) {
        if (!node) return;
        var tag = node.tagName ? node.tagName.toLowerCase() : '';
        
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
          var prefix = tag === 'h1' ? '#' : tag === 'h2' ? '##' : '###';
          blocks.push({type: 'heading', level: prefix, text: node.textContent.trim()});
          return;
        }
        
        if (tag === 'img') {
          var src = node.getAttribute('src') || '';
          if (src.includes('pbs.twimg.com/media/')) {
            imgIdx++;
            blocks.push({type: 'image', index: imgIdx});
          }
          return;
        }
        
        if (tag === 'figure' || tag === 'picture') {
          var figImg = node.querySelector('img');
          if (figImg) {
            var s = figImg.getAttribute('src') || '';
            if (s.includes('pbs.twimg.com/media/')) {
              imgIdx++;
              var caption = '';
              var figCap = node.querySelector('figcaption');
              if (figCap) caption = figCap.textContent.trim();
              blocks.push({type: 'image', index: imgIdx, caption: caption});
            }
          }
          return;
        }
        
        if (tag === 'pre' || tag === 'code') {
          blocks.push({type: 'code', text: node.textContent.trim()});
          return;
        }
        
        if (tag === 'ul' || tag === 'ol') {
          var items = [];
          node.querySelectorAll('li').forEach(function(li) {
            items.push(li.textContent.trim());
          });
          var prefix2 = tag === 'ul' ? '- ' : '1. ';
          blocks.push({type: 'list', items: items, prefix: prefix2});
          return;
        }
        
        if (tag === 'blockquote') {
          blocks.push({type: 'blockquote', text: node.textContent.trim()});
          return;
        }
        
        // For div/span/p, check if it has block children
        var hasBlock = false;
        for (var i = 0; i < node.children.length; i++) {
          var ct = node.children[i].tagName ? node.children[i].tagName.toLowerCase() : '';
          if (['h1','h2','h3','img','pre','ul','ol','blockquote','figure','picture','table'].indexOf(ct) !== -1) {
            hasBlock = true;
            break;
          }
          // Also check for divs with images inside
          if (ct === 'div' && node.children[i].querySelector('img[src*="pbs.twimg.com/media/"]')) {
            hasBlock = true;
            break;
          }
        }
        
        if (hasBlock) {
          // Recurse
          for (var j = 0; j < node.children.length; j++) {
            processNode(node.children[j]);
          }
        } else {
          // Leaf text node
          var txt = node.textContent.trim();
          if (txt && txt.length > 0) {
            blocks.push({type: 'text', text: txt});
          }
        }
      }
      
      for (var k = 0; k < contentDiv.children.length; k++) {
        processNode(contentDiv.children[k]);
      }
      
      return JSON.stringify({totalBlocks: blocks.length, imageCount: imgIdx, blocks: blocks});
    })()`
  });
  
  const md = JSON.parse((mdResult as any).value);
  fs.writeFileSync("test-blocks.json", JSON.stringify(md, null, 2), "utf-8");
  console.log("\nBlocks:", md.totalBlocks, "| Images:", md.imageCount);
  // Show first 20 blocks
  md.blocks.slice(0, 20).forEach((b: any, i: number) => {
    if (b.type === 'image') console.log(i + ": [IMAGE " + b.index + "]");
    else if (b.type === 'heading') console.log(i + ": [" + b.level + "] " + b.text.substring(0, 60));
    else console.log(i + ": [" + b.type + "] " + b.text.substring(0, 60));
  });

  await client.close();
})();
