# Manual smoke test

Use disposable new conversations and ordinary text. Load unpacked from `extension/`; no build is needed. After loading or reloading, refresh every AI tab.

## Local browser fixture

Run `npm run preview` and open `http://127.0.0.1:4173`.

- **Provider links**: each page imitates that site’s replies, composer, colours, and button shapes, and runs the real adapter and controls. Use them to check that the controls blend in with each site.
- **Dark** and **No split**: switch the page’s theme and split state.
- **Run editor checks**: covers multiline insertion, input events, rollback, duplicate-click protection, draft insertion, where the controls attach, link and tool chips, and copying an attachment into the composer once and removing it again. You can also paste or drop real files into the fixture composer to see its attachment tiles.
- **Popup**: shows the real popup, including the share settings. Settings are kept for the fixture tab only.
- **Bottom box**: shows the message the extension would have sent.

The fixture substitutes host detection and mocks extension messaging. It does not test Split View, tab switching, or any site’s real editor framework, and it never contacts an AI service. Stop the server with Ctrl+C.

## Controls appear in the right places

1. Open two AI chats in a native split (right-click a tab → Split View). On each side, confirm **Send both** sits just left of the site’s own Send or mic button. Confirm it looks like part of the composer: about the same height and corner shape as the site’s own buttons, in the site’s colours (for example Claude’s orange or Gemini’s blue for the menu’s Send button).
2. After a reply finishes, confirm **Share with…** sits in that reply’s toolbar, right after its Copy button (or before ⋯ More if the reply has no Copy). Your own messages and code blocks must not get one. A reply still being written gets one when it finishes.
3. Close all other AI tabs. Confirm both controls disappear. Open another AI tab and confirm they come back within a second or two.
4. Switch a site between light and dark, and try a narrow or short pane. Menus should open on the side with more room and scroll rather than cover their own button. Report any control that overlaps, clips, or wraps badly, with the provider and a screenshot.

## Send both / Send all

1. Type a short multiline prompt on the left and click **Send both** once. Confirm exactly one submission on each side. Repeat from the right.
2. Press the site’s own Send button or Enter. Confirm only that chat submits.
3. Open a third assistant in another tab. Open the arrow menu: the split partner is ticked and labelled with its side, and the third is listed as **Other tab**. Tick it, confirm the pill reads **Send all**, and send. Confirm each chat receives the prompt once.
4. Press **⌘⇧↩** (Ctrl+Shift+Enter) in the composer. Confirm it sends to the ticked chats. Confirm the shortcut does nothing in other text fields.
5. Put a draft in one destination and send. Confirm nothing is sent anywhere and both drafts survive. Repeat while a destination is still replying or on a sign-in page.
6. Let Chrome put a background AI tab to sleep (or discard it at `chrome://discards`). Confirm it is greyed out as **Asleep** and can’t be ticked.
7. Try prompts with a pasted link and with a tool chip (for example ChatGPT’s “Create image”). Confirm the other chats receive the full link address and the chip’s label.
8. Attach an image and a PDF (pick one, paste or drop the other), type a prompt, and click **Send both**. Confirm each other chat shows each file exactly once, waits for its upload, and then sends. Remove one attachment before sending and confirm only the remaining one is copied. Repeat with files only and no text.
9. On a site that keeps attachments across a page refresh, attach a file, refresh, and send. The extension never saw that file being added, so confirm nothing is sent and the notice asks you to reattach it. Try a file type a destination refuses, and confirm nothing is sent anywhere. If a copy cannot be removed, the notice should identify the affected chat.
10. If a notice says delivery is unconfirmed, inspect every chat before retrying.

## PDF and long-text regression

Use `tests/fixtures/bridge-test-a.pdf` and `bridge-test-b.pdf`; both contain synthetic verification tokens. In a new ChatGPT chat, attach both PDFs and paste at least 10,000 characters with distinct first and last markers, so ChatGPT makes a “Show in text field” card. Add a short instruction asking for both text markers and both PDF tokens. Send separately to Claude, Gemini, and Grok, each with an empty composer.

- The pasted-text card should expand, retaining the separate short instruction and all pasted text.
- Each destination should show exactly two PDFs, then submit only after the files are accepted. Gemini’s nested uploader/gem tiles must count as two files, not four or zero.
- Each reply should contain both markers and `ORCHID-472` / `CEDAR-815`. A successful click alone does not pass this test.
- Retry with one file removed, a failed upload, a nonempty destination, and a draft edited during staging. No source draft or user-added attachment may be erased on failure.
- Reattach files after reloading the extension; references to previously chosen local files do not survive a reload.

## Share

1. With the default setting (**Send right away** on), click **Share with…** in a reply’s toolbar and choose the chat on the other side. Confirm it is sent there exactly once, wrapped in the default message, and that nothing is sent in this chat.
2. In the popup, change **Message with the shared reply**, for example to `{assistant} said: {reply} Find the mistakes.` (the **{assistant}** and **{reply}** buttons insert those at the cursor). Close and reopen the popup to confirm it was saved. Share again and confirm your words arrive with the assistant’s name and reply filled in. Remove `{reply}` and confirm the reply goes at the end. Click **Reset** to restore the default.
3. Turn off **Send right away** in the popup. Share again and confirm the menu says it adds a draft, the draft appears, and it is **not** sent. Send it with that site’s own button.
4. Select part of an older reply, then click that reply’s **Share with…**. Confirm only the selection is shared and the heading mentions “the selected text”.
5. Choose a chat from another tab. Confirm it appears on the other side and then receives the message. In navigation mode, confirm the conversation that was there comes back when you show it again from the arrow menu.
6. Choose an assistant that isn’t open. Confirm it opens on the other side and receives the message after loading.
7. Share into a nonempty composer, or into a chat that is still replying. Confirm nothing is sent, the original draft survives, and an error explains why.
8. Exchange replies without waiting: share ChatGPT’s reply with Claude, then, while Claude is still writing its answer, click **Share with…** on Claude’s previous reply and choose ChatGPT. Confirm it is sent to ChatGPT right away. **Share with…** on a reply that is still being written, or being regenerated, must still say to wait.

## Show on the other side

1. In the arrow menu, click the split icon next to a chat from another tab. Confirm it replaces the other side, not this one.
2. With the management APIs, the replaced tab must stay open. In navigation mode, the same pane loads the chosen chat. Show the original again and confirm its saved conversation returns.
3. Put a draft in the other side, or start a reply there, then try to replace it. Navigation mode must refuse and leave that page intact. Do the same with a temporary chat.
4. Show an assistant you are signed out of, then replace it again from its sign-in page. Confirm it is not blocked.
5. Reverse sides with Chrome’s controls. Confirm the menus now say **Left side** and the icons point left.

## Popup and reloads

1. Open the popup. Without split management APIs it should explain how to make a split with Chrome’s menu. With them, **Create split** should arrange the two chosen tabs. Try incompatible pinned or grouped tabs and confirm a clear error without dismantling another split.
2. Reload the extension and refresh the AI pages. Confirm each control appears exactly once. If a control stops responding, check the extension’s errors on `chrome://extensions`.

Repeat sending and sharing with all four providers as both source and destination. Account layouts and locales can expose selector differences. Report the provider, visible error, and the changed control markup, without private conversation contents.
