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

## Language

1. Open the popup and set **Language → Interface language** to **简体中文**. The popup should change at once, including the message shown under **Sharing** if you have not customized it. A message you wrote yourself must stay as written.
2. Without refreshing, look at an open AI chat. **Send both**, **Share with…**, **Compare** and **Cross-review** should now read 同时发送, 分享到…, 对比 and 互评, and their menus, hints and notices should be in Chinese.
3. Share a reply and run a Cross-review. The text placed in the other chat should use the Chinese default messages and pane labels.
4. Switch back to **English**, then to **Automatic (browser language)**, and confirm each takes effect without reloading. Reopen the popup to confirm the choice was saved.

In the local fixture, choose the language in **Popup** first; the provider pages opened in the same tab then use it.

## Controls appear in the right places

1. Open two AI chats in a native split (right-click a tab → Split View). On each side, confirm **Send both** sits just left of the site’s own Send or mic button. Confirm it looks like part of the composer: about the same height and corner shape as the site’s own buttons, in the site’s colours (for example Claude’s orange or Gemini’s blue for the menu’s Send button).
2. After a reply finishes, confirm **Share with…** sits in that reply’s toolbar, right after its Copy button (or before ⋯ More if the reply has no Copy). Your own messages with a recognized Copy toolbar should also get one; individual code-block toolbars must not. A reply still being written must not be shareable until it finishes.
3. Close all other AI tabs. Confirm both controls disappear. Open another AI tab and confirm they come back within a second or two.
4. Switch a site between light and dark, and try a narrow or short pane. Menus should open on the side with more room and scroll rather than cover their own button. Report any control that overlaps, clips, or wraps badly, with the provider and a screenshot.

## Gemini regression checks

1. Put Gemini and ChatGPT in a native split. In a new Gemini chat, type two paragraphs with a blank line and click **Send both** immediately. Repeat from ChatGPT. Confirm both conversations receive the full text once.
2. Share a previous prompt and a finished reply in each direction. In Gemini, also select a passage and use **Select messages…** for multiple turns. Check that the recipient gets the selected text, in order, with the right speaker. While Gemini is still answering a new prompt, **Compare** should wait for that answer.
3. Compare the two finished answers in Gemini with **Send right away** off, then try with it on in empty composers. Run **Cross-review** and request a revision once the critiques finish. Verify the draft setting leaves the text editable and automatic delivery uses each recipient’s native Send.
4. Attach two local PDFs and repeat **Send both** in each direction. Check the two filenames and contents once per chat. Repeat with a draft or attachment already present at the destination and confirm it is kept.

For development, repeat on both Gemini layouts where available. One uses a Quill editor inside `rich-textarea`. The other uses a Lexical editor marked `data-test-id="prompt-input"` and separate sections for prompts and replies.

## Project and new-chat composers

1. Open a ChatGPT project landing page with another AI chat open. Before sending its first message, confirm **Send both** appears beside the project composer’s controls. Type a harmless prompt and send to both; confirm each chat receives it once. Project instructions and stored project files are not copied.
2. Open Claude’s new-chat page directly, then reach it again through the site’s New chat action. Confirm **Send both** is visible and clickable beside the composer controls, with no empty reserved gap or clipped button. Repeat with the sidebar expanded and collapsed, a narrow split, and both themes.
3. Navigate from a conversation to a new chat or project and back without reloading. Confirm the old composer control disappears and exactly one control appears on the current composer. Repeat after refreshing each page.

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
2. In the popup, choose **Message for → Replies** and change **Message with the shared reply**, for example to `{assistant} said: {reply} Find the mistakes.` (the **{assistant}** and **{reply}** buttons insert those at the cursor). Close and reopen the popup to confirm it was saved. Share again and confirm your words arrive with the assistant’s name and reply filled in. Remove `{reply}` and confirm the reply goes at the end. Click **Reset** to restore the default.
3. Turn off **Send right away** in the popup. Share again and confirm the menu says it adds a draft, the draft appears, and it is **not** sent. Send it with that site’s own button.
4. Select part of an older reply, then click that reply’s **Share with…**. Confirm only the selection is shared and the heading mentions “the selected text”.
5. Choose a chat from another tab. Confirm it appears on the other side and then receives the message. In navigation mode, confirm the conversation that was there comes back when you show it again from the arrow menu.
6. Choose an assistant that isn’t open. Confirm it opens on the other side and receives the message after loading.
7. Share into a nonempty composer, or into a chat that is still replying. Confirm nothing is sent, the original draft survives, and an error explains why.
8. Exchange replies without waiting: share ChatGPT’s reply with Claude, then, while Claude is still writing its answer, click **Share with…** on Claude’s previous reply and choose ChatGPT. Confirm it is sent to ChatGPT right away. **Share with…** on a reply that is still being written, or being regenerated, must still say to wait.

## Share prompts and selected messages

1. Click **Share with…** beside Copy on one of your sent prompts. Confirm the destination receives it as **my prompt**, not as an assistant’s reply. A custom reply template must not be applied. Highlight a portion first and confirm only that text is shared.
2. In the composer’s arrow menu, choose **Select messages…**. Select alternating prompts and replies in reverse order, then share. Confirm they arrive in their original conversation order, with **You:** and the source assistant’s name identifying each speaker, and a neutral request to continue from this context.
3. Try **Select all**, **Clear**, and **Back**. Only loaded messages should appear. Navigate away while a selection is being prepared: the action must stop rather than share a different conversation. An unfinished selected reply must block sharing.
4. Repeat in draft mode and with a nonempty destination. Draft mode must leave the shared context unsent; an existing destination draft must be preserved. Past prompt attachments are not copied by message selection; attach those files again in the current composer if needed.
5. In the popup, choose **Message for → Selected messages**. Replace “Please continue from this context” with a distinctive instruction, keeping `{content}`. Share several messages and confirm the instruction and full transcript arrive. Repeat with **My prompts**. Quickly switch between types and change **Send right away** while editing: each message must keep its own saved text. Reopen the popup to check persistence; **Reset** must affect only the chosen type.

## Compare answers

1. Put two supported chats in a native split and get a completed answer in each. Turn off **Send right away**, open **Compare** beside the latest reply and choose the left chat. Confirm its editable draft contains both complete answers, their pane labels and a request for evidence behind shared claims.
2. Clear that draft, enable **Send right away** and use **Compare latest answers…** in the composer menu. Choose the right chat and confirm only that chat submits once.
3. Open Compare while the other chat is generating, then check again when it finishes. Try changing a reply after the reviewer menu opens and try targeting an existing draft. Check that the extension explains what changed and preserves the draft.
4. In **Sharing → Message for → Compare**, save a custom instruction with `{answers}` in the middle. Reopen the popup, compare into a draft and check that both labelled answers appear in that position. Remove the placeholder and repeat to check that the answers appear at the end. **Reset** should restore just the comparison instructions.
5. In a Chinese Gemini chat, open **Share with…** under both a previous prompt and an answer. In draft mode, confirm the selected content appears in the destination with the correct speaker. If the reply toolbar is still loading, use **Share this chat’s latest reply…** from the composer menu.

## Cross-review

1. Start with different, completed answers in the two panes of a native split. Click **Cross-review** once. Check that each assistant receives the original answer from the opposite pane once. Read both critiques in their original chats.
2. When only one critique is complete, check the menu. Once both are complete, reopen **Cross-review** and choose one assistant under **Revise an answer**. Verify that only the chosen chat gets a revision request containing its own original and the other assistant’s critique of it.
3. Repeat with **Find errors** or **Suggest improvements** and **Send right away** off. Both composers should contain editable drafts. Change the instructions in one, keep the labelled answer intact, send both with the native controls, wait for both replies and choose a revision. Check that the revision stays a draft.
4. Try with an existing draft on one side, change panes while the menu is open, or ask an unrelated follow-up before requesting revision. Existing drafts should survive, and a revision should only use critiques from the same review round.
5. Under **Sharing → Message for → Cross-review**, set **All review modes** to “Use Chinese and cite the claim you are reviewing.” Give **Find errors** a separate instruction. Reopen the popup and start a **Find errors** review in draft mode. Both drafts should contain the shared guidance, the custom error checks and the opposite side’s labelled answer. Reset **Find errors**, then clear **All review modes** and check that **Compare** keeps its own template.

## Share generated files

Test a mixed Claude reply containing one large Markdown artifact card, two compact Markdown rows, a DRAWIO file, and a ZIP. The share menu should list all five. The large artifact should export through its own viewer’s **More options → Download as MD**, and the four compact rows should use their individual downloads. **Download all** must not be used. Check that an already-open viewer is preserved or restored and that changing the viewer during capture does not get undone. Use destinations that accept the included file types; a rejected upload must stop submission.

1. Ask Claude to generate two separate Markdown files with different verification tokens, plus a short explanation. In the completed reply’s **Share with…** menu, confirm both filenames and the checked **Include generated files** option appear, even when the cards sit outside the reply’s text block. Share to an empty chat and confirm both file contents arrive, with no duplicate or missing file. Repeat with two cards sharing the same title.
2. Uncheck the files option and share again: only the rendered text should arrive. Highlight an excerpt first and confirm no generated files are included. Select several replies containing generated files through **Select messages…** and confirm all listed files belong to the selected replies.
3. Try a removed or unreadable download, and a file a destination refuses. The share must stop with an explanation rather than send incomplete context. Repeat in draft mode: uploads may reach the destination provider, but the chat must not submit.
4. Check recognized generated download cards from the other providers too. Ordinary citation links and original attachments from old user prompts must not be treated as generated downloads. Repeat after refreshing the source tab following an extension reload.

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
