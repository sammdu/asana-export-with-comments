(async () => {
    // ===== Tunables =====
    const LOG_EVERY = 10;
    const OPEN_DELAY = 250;        // ms after clicking title before searching for the pane
    const WAIT_TIMEOUT = 12_000;   // ms to wait for the title field to appear
    const FEED_SCROLL_PAUSE = 250; // ms between comment feed scrolls
    const MAX_FEED_PAGES = 300;

    // ===== Utils =====
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const until = async (fn, timeout = WAIT_TIMEOUT, step = 60) => {
        const t0 = performance.now();
        for (; ;) {
            const v = fn();
            if (v) return v;
            if (performance.now() - t0 > timeout) throw new Error("Timed out waiting for element");
            await sleep(step);
        }
    };
    const byText = (el) => (el?.innerText ?? el?.textContent ?? "").trim();
    const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    const downloadJSON = (obj, name) => {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
    };
    const hash = (s) => { // djb2-ish for stable de-dup keys
        let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
        return (h >>> 0).toString(36);
    };

    // ===== Columns (groups) tailored to your DOM =====
    function getBoardColumns() {
        return Array.from(document.querySelectorAll('.BoardColumn.BoardBody-column')).filter(isVisible);
    }
    function getGroupHeaderTitles() {
        // Your snapshot shows BoardGroupHeader h3s for column names
        return Array.from(document.querySelectorAll('.BoardGroupHeader h3.BoardColumnHeaderTitle'))
            .map(n => byText(n))
            .filter(Boolean);
    }
    function getColumnNameByIndex(idx, names) {
        return (names[idx] || `Column ${idx + 1}`).trim();
    }

    // ===== Card collection (hierarchy-aware & read-only click target) =====
    function getCardsInColumn(col) {
        const scroller = col.querySelector(':scope [data-testid="VerticalScroller"]') || col;
        const cards = Array.from(
            scroller.querySelectorAll(':scope .BoardColumnScrollableContainer-cardsList .BoardCard-layout[data-task-id]')
        ).filter(isVisible);

        return cards.map(card => {
            const gid = card.getAttribute('data-task-id');
            let clickTarget = card.querySelector('.BoardCard-taskName') || card;
            return gid ? { gid, clickTarget } : null;
        }).filter(Boolean);
    }

    // ===== Task pane =====
    async function waitForTaskPane() {
        await sleep(OPEN_DELAY);
        return until(() => document.querySelector(
            [
                '[aria-label="Task Name"]',
                '[aria-label="Task name"]',
                '[data-testid*="TaskName"]',
                '[data-testid*="TaskTitle"]',
                'input[placeholder*="Task name"]',
                'h1[contenteditable="true"]',
                'h2[contenteditable="true"]'
            ].join(",")
        ));
    }
    function readTaskTitle() {
        const el = document.querySelector(
            [
                '[aria-label="Task Name"]',
                '[aria-label="Task name"]',
                '[data-testid*="TaskName"]',
                '[data-testid*="TaskTitle"]',
                'input[placeholder*="Task name"]',
                'h1[contenteditable="true"]',
                'h2[contenteditable="true"]'
            ].join(",")
        );
        return el ? ("value" in el ? el.value : byText(el)).trim() : "";
    }
    function taskPermalinkAndId(fallbackGid) {
        const link = document.querySelector('a[href*="/task/"], a[href^="/0/"]');
        const href = link?.getAttribute?.("href");
        if (href) {
            const abs = new URL(href, location.origin).toString();
            const m = abs.match(/\/task\/(\d+)|\/(?:0|1)\/\d+\/(\d+)/);
            const gid = m ? (m[1] || m[2]) : fallbackGid || null;
            return { href: abs, gid };
        }
        const gid = fallbackGid || null;
        const abs = gid ? new URL(`/0/0/${gid}`, location.origin).toString() : location.href;
        return { href: abs, gid };
    }

    // ===== Comments: robust paging + exact once-only capture =====
    function ensureCommentsTabSelected() {
        const feedRoot = document.querySelector('.TaskStoryFeed');
        if (!feedRoot) return;
        const tablist = feedRoot.querySelector('[role="tablist"]');
        const commentsTab = tablist?.querySelector('#Comments[role="tab"]');
        if (commentsTab && commentsTab.getAttribute('aria-selected') !== 'true') {
            try { commentsTab.click(); } catch { }
        }
    }

    const atBottom = (scroller) => Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1; // sub-pixel safe  :contentReference[oaicite:3]{index=3}

    async function exhaustCommentFeed() {
        const feed = document.querySelector('.TaskStoryFeed');
        if (!feed) return;

        ensureCommentsTabSelected();

        // Prefer the nearest scrollable ancestor of the feed (usually the feed itself)
        let scroller = feed;
        let n = feed;
        while (n && n !== document.body) {
            const cs = getComputedStyle(n);
            if (/(auto|scroll)/.test(cs.overflowY || '') || (n.scrollHeight > n.clientHeight)) { scroller = n; break; }
            n = n.parentElement;
        }

        // Expand “Show more” buttons inside truncated rich text each pass
        const expandIfTruncated = () => {
            for (const b of feed.querySelectorAll('button')) {
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                const inRich = b.closest('.TruncatedRichText, [class*="RichText"]');
                const isExpand = /^(show more|see more|read more|expand)$/.test(txt) &&
                    inRich && !/like|react|menu|more options/.test(aria);
                if (isExpand) { try { b.click(); } catch { } }
            }
        };

        let pages = 0, stable = 0, lastSize = -1;
        const seenIds = new Set(); // live-count to decide when to stop
        while (pages++ < MAX_FEED_PAGES) {
            expandIfTruncated();
            scroller.scrollTop = scroller.scrollHeight;
            await sleep(FEED_SCROLL_PAUSE);

            // Count top-level stories currently rendered to detect progress
            const nowStories = document.querySelectorAll('.TaskStoryFeed .FeedBlockStory[data-testid="FeedBlockStory"]');
            if (nowStories.length === lastSize && atBottom(scroller)) {
                if (++stable >= 3) break;
            } else {
                stable = 0;
            }
            lastSize = nowStories.length;
        }
    }

    function richTextToPlain(el) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const blockSel = 'p,div,li,ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6';
        clone.querySelectorAll(blockSel).forEach(node => node.append(document.createTextNode('\n')));
        clone.querySelectorAll('li').forEach(li => li.insertAdjacentText('afterbegin', '• '));
        let text = (clone.innerText || '').replace(/\u00A0/g, ' ');
        return text.replace(/\n{3,}/g, '\n\n').trim();
    }

    function readCommentsOnceOnly() {
        // *** The critical change: only select top-level stories in the Comments feed. ***
        const stories = Array.from(document.querySelectorAll(
            '.TaskStoryFeed .FeedBlockStory[data-testid="FeedBlockStory"]'
        ));

        const out = [];
        const dedup = new Set();

        for (const s of stories) {
            // Skip task-creation composer or stories without a body
            if (s.closest('.TaskCreationBlockStory')) continue;

            const bodyHost = s.querySelector('.BlockStoryStructure-body');
            if (!bodyHost) continue;

            // Find visible rich text region
            const bodyRich = bodyHost.querySelector('.TruncatedRichText, .RichText3, [class*="RichText"]') || bodyHost;
            const text = richTextToPlain(bodyRich);
            if (!text) continue;

            const author = (s.querySelector('.BlockStory-actorName')?.innerText || '').trim() || null;
            const when =
                s.querySelector('.BlockStory-timestamp time')?.getAttribute('datetime') ||
                (s.querySelector('.BlockStory-timestamp')?.innerText || '').trim() || null;

            // Prefer a stable story id if present; otherwise hash author|when|text
            const storyId = s.getAttribute('data-story-id') ||
                hash([author || '', when || '', text].join('|'));

            if (dedup.has(storyId)) continue;
            dedup.add(storyId);

            // Heuristic: mark system vs comment using presence of rich text + actor
            const type = author && text ? 'comment' : 'story';

            out.push({ type, text, author, created: when });
        }
        return out;
    }

    // ===== Main =====
    const columns = getBoardColumns();
    const headerNames = getGroupHeaderTitles();
    if (!columns.length) {
        console.warn("No columns matched .BoardColumn.BoardBody-column — check your markup snapshot.");
    }

    // Pre-render columns (virtualization nudge) & build groups
    const groups = [];
    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const name = getColumnNameByIndex(i, headerNames);
        const scroller = col.querySelector(':scope [data-testid="VerticalScroller"]') || col;
        for (let k = 0; k < 8; k++) { scroller.scrollTop = scroller.scrollHeight; await sleep(FEED_SCROLL_PAUSE); }
        const items = getCardsInColumn(col);
        groups.push({ group_name: name, items });
    }

    // De-dup tasks by gid (keep first group encounter)
    const gidToClick = new Map();
    const gidToGroup = new Map();
    for (const g of groups) {
        for (const { gid, clickTarget } of g.items) {
            if (!gidToClick.has(gid)) {
                gidToClick.set(gid, clickTarget);
                gidToGroup.set(gid, g.group_name);
            }
        }
    }
    const work = Array.from(gidToClick, ([gid, el]) => ({ gid, el, group_name: gidToGroup.get(gid) }));

    // Check-in
    if (!window.confirm(`Found ${work.length} tasks across ${groups.length} groups. Proceed?`)) {
        console.log("Canceled by user."); return;
    }

    // Scrape
    const scrapedByGroup = new Map();
    let idx = 0;

    for (const { gid, el, group_name } of work) {
        idx++;
        try {
            // Safe click in the center of the title/card to avoid likes/toggles
            if (el) {
                const rect = el.getBoundingClientRect();
                el.dispatchEvent(new MouseEvent("click", {
                    bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
                }));
            }
            await waitForTaskPane();

            const title = readTaskTitle();
            await exhaustCommentFeed();        // load & expand everything
            const comments = readCommentsOnceOnly();  // <-- exact once-only capture

            const { href, gid: gid2 } = taskPermalinkAndId(gid);
            const task_gid = gid || gid2 || null;

            const taskObj = { task_gid, title, permalink_url: href, comments };
            if (!scrapedByGroup.has(group_name)) scrapedByGroup.set(group_name, []);
            scrapedByGroup.get(group_name).push(taskObj);

            if (idx % LOG_EVERY === 0) console.log(`Scraped ${idx}/${work.length} tasks…`);

            const closeBtn = document.querySelector('button[aria-label*="Close"], [data-testid*="CloseTaskPane"], [aria-label*="Dismiss"]');
            if (closeBtn) try { closeBtn.click(); } catch { }
            await sleep(OPEN_DELAY);
        } catch (e) {
            console.warn("Skip due to error:", e);
        }
    }

    // Export preserving on-screen column order
    const exportGroups = groups.map(g => {
        const list = scrapedByGroup.get(g.group_name) || [];
        return { group_name: g.group_name, task_count: list.length, tasks: list };
    });

    downloadJSON({
        exported_at: new Date().toISOString(),
        project_url: location.href,
        groups: exportGroups
    }, "asana_board_by_group_with_comments.json");

    console.log("Done. Downloaded asana_board_by_group_with_comments.json");
})();