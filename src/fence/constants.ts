// Ciel's fence strings, ported character for character from /Users/lap16932/personal/ciel.

// actions.go:51 reviewMCPServers
export const REVIEW_MCP_SERVERS = ['gitlab', 'kb'];

// audee additions: Jira for the review's ticket check. The server defined as "atlassian" in audee's mcp_servers
// is handed to review sessions under the claude.ai connector's name, so its tools carry the names the
// wf-apo-mr-review workflow calls (mcp__claude_ai_Atlassian__getJiraIssue). Sessions may only read with it.
export const REVIEW_JIRA_SERVER = 'atlassian' as const;
export const REVIEW_JIRA_ALIAS = 'claude_ai_Atlassian';
export const REVIEW_JIRA_READ_TOOLS = ['getAccessibleAtlassianResources', 'getJiraIssue'].map((t) => `mcp__${REVIEW_JIRA_ALIAS}__${t}`);
export const REVIEW_JIRA_WRITE_TOOLS = [
  'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue', 'addOrEditJiraIssueComment', 'addWorklogToJiraIssue', 'createIssueLink',
  'createConfluencePage', 'updateConfluencePage', 'createConfluenceFooterComment', 'createConfluenceInlineComment',
].map((t) => `mcp__${REVIEW_JIRA_ALIAS}__${t}`);

// actions.go:60-64 reviewDeniedTools
export const REVIEW_DENIED_TOOLS = (
  'mcp__gitlab__approve_mr,mcp__gitlab__merge_mr,mcp__gitlab__ship_mr,' +
  'mcp__gitlab__update_mr,mcp__gitlab__create_mr,mcp__gitlab__play_job,mcp__gitlab__retry_pipeline,Bash(git push *),' +
  'Bash(printenv *),Bash(env *),Bash(ps *),Bash(security *),' +
  'Bash(/usr/bin/printenv *),Bash(/usr/bin/env *),Bash(/bin/ps *),Bash(/usr/bin/security *),' +
  'mcp__kb__kb_save,mcp__kb__kb_promote,mcp__kb__kb_enrich,mcp__kb__kb_batch_enrich,mcp__kb__kb_file_answer'
).split(',');

// detect.go:104 classifyDeniedTools
export const CLASSIFY_DENIED_TOOLS = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Workflow,mcp__gitlab'.split(',');

// detect.go:90-102 classifySystem
export const CLASSIFY_SYSTEM = `You triage Microsoft Teams group-chat messages for one engineer ("the user").
Decide whether the NEW message asks the user to do something, and what.
People write in Vietnamese or English and may address the user by @mention, by name or nickname, or implicitly by replying to the user's earlier message.
A request addressed to everyone or to someone else is not addressed to the user.
intent values:
- review_mr: asks the user to review, check, or approve a GitLab merge request
- code_mapping: asks the user to write, create, or fix a code mapping (CodeMapping, EventSource mapping) for a game event log
- question: asks the user a question or for help
- other: anything else
mr_urls: every merge request URL the request refers to, copied exactly from the messages (the request may point at an MR posted in an earlier message).
summary: one short sentence in English describing what is being asked; no personal names.`;

// kbquery.go:58 kbQueryTools
export const KB_QUERY_TOOLS = 'mcp__kb__kb_read_doc,mcp__kb__kb_discover,mcp__kb__kb_specs,mcp__kb__kb_status'.split(',');

// kbquery.go:62-65 kbQueryDenied
export const KB_QUERY_DENIED = (
  'mcp__kb__kb_save,mcp__kb__kb_promote,mcp__kb__kb_enrich,mcp__kb__kb_batch_enrich,' +
  'mcp__kb__kb_file_answer,mcp__kb__kb_gaps,mcp__kb__kb_compile_context,mcp__kb__kb_search,mcp__kb__kb_answer,Skill,' +
  'Read(//**/.env),Read(//**/.env.*),Read(//**/*.env),Read(//**/*.pem),Read(//**/*.key),Read(//**/*.p12),' +
  'Read(//**/id_rsa*),Read(//**/id_ed25519*),Read(//**/.git/**),Read(//**/secrets/**)'
).split(',');

// kbquery.go:69-72 kbQueryRepoDenied
export const KB_QUERY_REPO_DENIED = ['**/application-*', '**/*.properties', '**/*.sh', '**/*.log', '**/*_log',
  '**/*.patch', '**/repomix-output.*', '**/.npmrc', '**/*.jks', '**/*.keystore', '**/*.tfstate*', '**/*.tfvars',
  '**/kubeconfig*', '**/credentials*', '**/*secret*', '**/docker-compose*', '**/values*.yaml', '**/values*.yml',
  '**/.claude/**', '**/plans/**'];

// kbquery.go:77 kbQueryWikiDenied
export const KB_QUERY_WIKI_DENIED = ['inbox/**', 'people/**'];

// mapping.go:42-61
export const PROBE_PAYLOAD = './eventsource.json';
export const PROBE_DEGRADED_PAYLOAD = './eventsource-degraded.json';
export const PROBE_CACHED_REF = 'refs/remotes/origin/staging';
export const GDS_CONTRACT_TOOL = 'mcp__claude_ai_GDS_Connector__gds_liveops___data_contract';

export function probeCommands(skill: string): string[] {
  const rules: string[] = [];
  for (const payload of [PROBE_PAYLOAD, PROBE_DEGRADED_PAYLOAD]) {
    const cmd = 'bash ' + skill + '/scripts/probe-pipeline.sh ' + payload;
    rules.push('Bash(' + cmd + ')', 'Bash(' + cmd + ' --ref ' + PROBE_CACHED_REF + ')');
  }
  return rules;
}

// audee additions
export const REVIEW_EXTRA_DENIED = [
  'Read(~/.claude.json)', 'Read(~/.ssh/**)', 'Read(~/.audee/**)', 'Read(~/.aws/**)', 'Read(~/Library/Keychains/**)',
  'Bash(sh -c *)', 'Bash(bash -c *)', 'Bash(zsh -c *)', 'Bash(eval *)', 'Bash(exec *)', 'Bash(export *)', 'Bash(set)', 'Bash(declare *)',
  // MCP tokens are substituted into --mcp-config, so they sit on the claude process's argv.
  'Bash(pgrep *)', 'Bash(/usr/bin/pgrep *)',
  // A wakeup outlives the background workflow's completion notice and resumes the session too late.
  'ScheduleWakeup',
];

export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

export const READ_ONLY_MCP_TOOLS: Record<string, string[]> = {
  grafana: ['search_dashboards', 'get_dashboard_by_uid', 'query_prometheus', 'query_loki_logs'],
};

export const MCP_WRITE_DENIED: Record<string, string[]> = {
  grafana: ['update_dashboard', 'create_incident', 'add_activity_to_incident', 'update_incident', 'alerting_manage_rules',
    'alerting_manage_routing', 'alerting_manage_silences', 'create_annotation', 'update_annotation', 'delete_annotation',
    'create_snapshot', 'delete_snapshot', 'create_folder', 'create_datasource', 'update_datasource', 'install_plugin',
    'update_alert_group', 'grafana_api_request'],
};
