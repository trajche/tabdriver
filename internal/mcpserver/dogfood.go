package mcpserver

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// addDogfood registers exploratory QA ("dogfooding") as an MCP prompt, which agents such as
// Claude Code show as a slash command, and as a tool for agents that don't support prompts.
func addDogfood(s *mcp.Server) {
	s.AddPrompt(&mcp.Prompt{
		Name:        "dogfood",
		Description: "Explore a web app in your browser like a user, find bugs and UX problems, and write a report with screenshot evidence.",
		Arguments: []*mcp.PromptArgument{
			{Name: "url", Description: "Where to start, e.g. https://app.example.com", Required: true},
			{Name: "focus", Description: "Optional: an area to concentrate on, e.g. the billing page."},
			{Name: "output_dir", Description: "Optional: where the report and screenshots go (default ./dogfood-output/<site>-<date>)."},
		},
	}, func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		a := req.Params.Arguments
		return &mcp.GetPromptResult{
			Description: "Dogfood " + a["url"],
			Messages: []*mcp.PromptMessage{{
				Role:    "user",
				Content: &mcp.TextContent{Text: dogfoodGuide(a["url"], a["focus"], a["output_dir"])},
			}},
		}, nil
	})

	type guideIn struct {
		URL       string  `json:"url" jsonschema:"Where to start, e.g. https://app.example.com"`
		Focus     *string `json:"focus,omitempty" jsonschema:"An area to concentrate on."`
		OutputDir *string `json:"outputDir,omitempty" jsonschema:"Where the report and screenshots go."`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "dogfood_guide",
		Description: "Instructions for dogfooding (exploratory QA) a web app with these tools: explore it like a user, " +
			"find bugs and UX problems, and write a report with screenshot evidence. Call this first when asked to dogfood, QA or bug-hunt a site."},
		func(_ context.Context, _ *mcp.CallToolRequest, in guideIn) (*mcp.CallToolResult, any, error) {
			deref := func(p *string) string {
				if p == nil {
					return ""
				}
				return *p
			}
			return text(dogfoodGuide(in.URL, deref(in.Focus), deref(in.OutputDir))), nil, nil
		})
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func dogfoodGuide(target, focus, outDir string) string {
	if outDir == "" {
		host := target
		if u, err := url.Parse(target); err == nil && u.Host != "" {
			host = u.Host
		}
		slug := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(host), "-"), "-")
		outDir = "./dogfood-output/" + slug + "-" + time.Now().Format("2006-01-02")
	}
	if focus == "" {
		focus = "the whole app"
	}
	r := strings.NewReplacer("{URL}", target, "{FOCUS}", focus, "{OUT}", outDir, "{DATE}", time.Now().Format("2006-01-02"))
	return r.Replace(dogfoodTemplate)
}

const dogfoodTemplate = `# Dogfood {URL}

Explore {URL} the way a real user would, find what's broken or confusing, and write a report where every issue comes with evidence someone else can follow. Focus: {FOCUS}. Output: {OUT}/ (report.md, screenshots/, and a storyboard folder per interactive issue).

You are working in the user's own browser, with their logins, while they may be watching. So:
- Don't do anything with real consequences: no payments, transfers, purchases, deleting real data, sending messages or invitations to real people, or changing account settings. When a flow needs one of these, stop at the confirmation step and note it.
- If the site asks for a login, 2FA code or CAPTCHA, call wait_for_user and let the user do it. Never ask for passwords.
- Test as a user: judge only what you see in the browser. Don't read the app's source code.

## 1. Set up
Create {OUT}/screenshots/ and write {OUT}/report.md from the template at the end. Open {URL} with open_tab.

## 2. Orient
snapshot, then screenshot with annotate=true and path={OUT}/screenshots/00-start.png. Map the main navigation and decide the order of sections (most important first). Check errors.

## 3. Explore, and document as you go
Visit each section. On every page: snapshot, look at the page (screenshot), and call errors. After small interactions, snapshot with diff=true shows just what changed. Try what a user would try: buttons, forms, menus, dialogs, search, filters, sorting, pagination, empty and error states, long or odd input, going back and forward, reloading mid-flow. Walk real end-to-end tasks.

When something is wrong, stop and document it before exploring further:
1. Reproduce it once more, so you know it's real.
2. Interactive issue: record_start with dir={OUT}/issue-NNN, walk through the steps again from the start, then record_stop. That saves a storyboard (a frame per action showing what was clicked, typed or scrolled where, plus each page load) and recording.gif. Then screenshot the broken state to {OUT}/screenshots/issue-NNN-result.png with annotate=true.
3. Visible-on-load issue (typo, overlap, clipped text, broken image): one annotated screenshot, issue-NNN.png.
4. Copy relevant lines from errors or console into the issue.
5. Append the issue to report.md right away, numbered ISSUE-001, ISSUE-002, ...

A click result may say another element covers the target. That means a real user's click would land on the cover (a banner or overlay): worth checking whether users can reach the control at all.

## What counts as an issue
- Functional: something doesn't work, wrong result, lost input, broken link, dead button, stuck loading.
- Errors: exceptions, failed requests or HTTP 4xx/5xx in errors, especially after an action.
- UX: confusing flow, missing feedback, unclear errors, surprising navigation, no way back.
- Content: typos, placeholder or lorem text, wrong labels, untranslated strings, stale data.
- Visual: overlapping or clipped elements, broken layout, unreadable contrast, broken images.
- Accessibility: controls without labels (unnamed buttons in snapshot), keyboard traps, focus lost.
- Performance: pages or actions that take several seconds.

Severity: critical (blocks a core task or loses data), high (major feature broken, no workaround), medium (works with friction or a workaround), low (cosmetic).

## 4. Wrap up
Aim for 5-10 well-documented issues; evidence matters more than count. Then update the summary counts so they match the issues, add a short list of what you covered and what you skipped, release_tab, and tell the user where the report is with the top issues.

## Report template
` + "```markdown" + `
# Dogfood report: {URL}

Date: {DATE} · Focus: {FOCUS}

## Summary
| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

Covered: ...
Not covered: ...

## Issues

### ISSUE-001: <short title>
- **Severity:** high · **Category:** functional
- **Page:** <url>
- **What happens:** ...
- **Expected:** ...
- **Steps to reproduce:**
  1. ...
  2. ...
- **Storyboard:** [issue-001/storyboard.html](issue-001/storyboard.html) ![](issue-001/recording.gif)
- **Result:** ![](screenshots/issue-001-result.png)
- **Errors:** <lines from errors/console, or none>
` + "```\n"
