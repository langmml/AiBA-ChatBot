# Empire ABA chat widget

A floating chat widget ("Riley") for the Empire ABA website. It answers visitor
questions with Claude, gathers a name plus a phone number or email, and emails
the lead to the team.

Everything is served from one Cloudflare Worker, so the site needs a single
script tag and the API keys never reach the browser.

- `worker/src/index.js` — the Worker: routes, system prompt, rate limiting, CORS.
- `worker/src/widget.txt` — the widget's source. **This is the only copy.** The
  Worker imports it as a string and serves it at `/widget.js`.
- `index.html` — a demo page published to Cloudflare Pages
  (`aiba-chatbot.pages.dev`) that loads the widget from the deployed Worker.

## Routes

| Route             | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `GET /widget.js`  | Serves the widget script. Also served from `/`.                 |
| `GET /avatar.jpg` | Serves Riley's avatar image.                                    |
| `POST /chat`      | Sends the conversation to the Anthropic Messages API and returns Riley's reply. |
| `POST /lead`      | Emails the captured lead and transcript via Resend.             |

`POST` routes are restricted to the origins listed in `ALLOWED_ORIGINS` and
rate limited to 30 requests per minute per IP.

## Deploy

Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git**.
Pick this repository and set:

- **Root directory:** `worker`
- **Deploy command:** `npx wrangler deploy`

Cloudflare reads `worker/wrangler.toml` for the rest. Pushes to `main` redeploy.

To deploy from your machine instead: `cd worker && npm install && npm run deploy`.

## Secrets

Set these once from the terminal — they are never committed:

```sh
cd worker
npx wrangler secret put ANTHROPIC_API_KEY   # required for /chat
npx wrangler secret put RESEND_API_KEY      # required for /lead
```

## Configuration

Public settings live in `[vars]` in `worker/wrangler.toml` and are safe to
commit. Edit them there and redeploy:

- `ALLOWED_ORIGINS` — comma-separated site origins allowed to POST. Exact
  origins, no trailing slash.
- `MODEL` — `claude-haiku-4-5` (cheapest) or `claude-sonnet-4-6` (balanced).
- `LEAD_TO` — inbox that receives leads.
- `LEAD_FROM` — verified Resend sender.

## Embedding on the client's site

Add the Worker's origin to `ALLOWED_ORIGINS`, redeploy, then drop one tag on
the page:

```html
<script src="https://aiba-chatbot.mml114128.workers.dev/widget.js"
  data-endpoint="https://aiba-chatbot.mml114128.workers.dev"
  data-mode="ai"
  data-agent="Riley"
  data-title="Empire ABA"
  data-accent="#2eaae1"
  data-avatar="https://aiba-chatbot.mml114128.workers.dev/avatar.jpg"></script>
```

Optional attributes: `data-mode="capture"` for a scripted flow with no AI, and
`data-debug="true"` to log configuration and show real error text in the chat.
