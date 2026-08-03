import type { PosDatabase } from "./db.js";

function addColumn(db: PosDatabase, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/, 1)[0]!;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function applyBusinessSchema(db: PosDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_sessions (
      business_session_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      session_no INTEGER NOT NULL CHECK(session_no BETWEEN 1 AND 999),
      state TEXT NOT NULL CHECK(state IN ('open','closed')),
      opened_by TEXT NOT NULL,
      opened_terminal_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_by TEXT,
      closed_terminal_id TEXT,
      closed_at TEXT,
      reopen_reason TEXT,
      UNIQUE(event_id, session_no)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_business_sessions_open_event
      ON business_sessions(event_id) WHERE state='open';
    CREATE TABLE IF NOT EXISTS staff_members (
      staff_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_staff_assignments (
      assignment_id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      responsible_number TEXT NOT NULL CHECK(length(responsible_number)=3),
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('operator','manager','admin')),
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      UNIQUE(event_id, responsible_number),
      FOREIGN KEY(staff_id) REFERENCES staff_members(staff_id)
    );
    CREATE TABLE IF NOT EXISTS staff_auth_sessions (
      auth_session_id TEXT PRIMARY KEY,
      token_sha256 TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      responsible_number TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('operator','manager','admin')),
      terminal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      revoke_reason TEXT,
      FOREIGN KEY(staff_id) REFERENCES staff_members(staff_id)
    );
  `);
  addColumn(db, "cash_sessions", "business_session_id TEXT");
  addColumn(db, "cash_sessions", "opened_by TEXT");
  addColumn(db, "cash_sessions", "opened_terminal_id TEXT");
  addColumn(db, "cash_sessions", "closed_by TEXT");
  addColumn(db, "cash_sessions", "closed_terminal_id TEXT");
  addColumn(db, "cash_sessions", "closed_at TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_sessions_business_cashbox ON cash_sessions(business_session_id,cashbox_id) WHERE business_session_id IS NOT NULL;");

  // Older checkout code created an open cash session before the opening cash count.
  db.exec("UPDATE cash_sessions SET state='preparing' WHERE state='open' AND opening_yen IS NULL");
  const legacyGroups = db.prepare(`SELECT event_id,business_date,MAX(created_at) AS latest_at,
    MAX(CASE WHEN state IN ('preparing','open') THEN 1 ELSE 0 END) AS active
    FROM cash_sessions WHERE business_session_id IS NULL GROUP BY event_id,business_date ORDER BY event_id,latest_at`).all() as Array<{ event_id: string; business_date: string; latest_at: string; active: number }>;
  const nextNumber = new Map<string, number>();
  const latestActive = new Map<string, string>();
  for (const group of legacyGroups) if (group.active) latestActive.set(group.event_id, group.business_date);
  for (const group of legacyGroups) {
    const previous = nextNumber.get(group.event_id) ?? Number((db.prepare("SELECT COALESCE(MAX(session_no),0) AS maximum FROM business_sessions WHERE event_id=?").get(group.event_id) as { maximum: number }).maximum);
    const sessionNo = previous + 1;
    if (sessionNo > 999) throw new Error(`営業セッション番号を移行できません: ${group.event_id}`);
    nextNumber.set(group.event_id, sessionNo);
    const businessSessionId = `legacy:${group.event_id}:${group.business_date}:${String(sessionNo).padStart(3, "0")}`;
    const state = group.active && latestActive.get(group.event_id) === group.business_date ? "open" : "closed";
    db.prepare(`INSERT OR IGNORE INTO business_sessions(business_session_id,event_id,business_date,session_no,state,opened_by,opened_terminal_id,opened_at,closed_by,closed_terminal_id,closed_at)
      VALUES (?,?,?,?,?,'legacy-migration','legacy-migration',?,CASE WHEN ?='closed' THEN 'legacy-migration' END,CASE WHEN ?='closed' THEN 'legacy-migration' END,CASE WHEN ?='closed' THEN ? END)`)
      .run(businessSessionId, group.event_id, group.business_date, sessionNo, state, group.latest_at, state, state, state, group.latest_at);
    db.prepare("UPDATE cash_sessions SET business_session_id=? WHERE event_id=? AND business_date=? AND business_session_id IS NULL").run(businessSessionId, group.event_id, group.business_date);
    if (state === "closed") db.prepare("UPDATE cash_sessions SET state='closed',closed_at=COALESCE(closed_at,?) WHERE business_session_id=? AND state!='closed'").run(group.latest_at, businessSessionId);
  }
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (9,?) ON CONFLICT(version) DO NOTHING").run(new Date().toISOString());
  db.prepare("INSERT INTO app_metadata(key,value) VALUES ('schema_version','9') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}
