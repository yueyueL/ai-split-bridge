# AI Split Bridge privacy policy

Last updated: 15 October 2026

AI Split Bridge is a Chrome extension for sending one prompt to several AI chats and sharing replies between them. It runs entirely in your browser. The developer runs no server and receives none of your data.

## What the extension handles

- **Prompts**: the text, links, and attached files in the composer of ChatGPT, Claude, Gemini, or Grok. They are read only when you click **Send both** (or use its shortcut).
- **Replies**: the text of a reply, read only when you click **Share with…**.
- **Open AI tabs**: the titles and addresses of ChatGPT, Claude, Gemini, and Grok tabs in the current window, used to list the chats you can send to and to tell which side of Split View each one is on. Other tabs and sites are not accessed.
- **Share settings**: whether shared replies are sent right away, and the message you wrote to go with them.

## How it is used

Only to carry out the action you clicked. The prompt or reply is placed in the composer of each chat you chose, and that site's own Send button is clicked. From then on it is handled by that AI provider under its own privacy policy, exactly as if you had typed it there yourself.

## Where it is stored

- **Share settings** are saved in Chrome's sync storage, so they follow your Chrome profile if Chrome sync is on.
- **Session memory**: recently used tab IDs and, when a pane has to be navigated, the conversation address each pane showed. These are kept in Chrome's session storage for the current window, removed when the window closes, and cleared when Chrome quits.
- **Prompts, replies, and attachments are not stored.** They stay in memory only while being moved between your tabs.

## What it does not do

- It makes no network requests of its own and sends nothing to the developer or any third party.
- It has no analytics, tracking, advertising, or remote code.
- Your data is not sold, not used for advertising or to determine creditworthiness, not used for anything unrelated to the features above, and not read by people.

## Limited Use

The use of information received through this extension adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Permissions

- `storage`: for the share settings and the session memory described above.
- Access to `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, and `grok.com`: to add the extension's controls to those sites, and to read and fill their composers when you use the controls. No other site is accessed.

## Your choices

You can change or reset the share settings in the extension's popup. Removing the extension deletes everything it stored.

## Contact

Questions about this policy can be sent to the contact email shown on the extension's Chrome Web Store page.
