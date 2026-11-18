package com.zerdazi.life.server

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

typealias Row = Map<String, Any?>

// On-device port of server/src/db.js. Same schema as the server, so a copy of
// the server's life.sqlite can be dropped in as assets/seed.sqlite and is used
// as the starting database on first launch.
object Db {
    private const val NAME = "life.sqlite"
    private lateinit var helper: SQLiteOpenHelper

    fun init(ctx: Context) {
        if (::helper.isInitialized) return
        val app = ctx.applicationContext
        seedIfFirstRun(app)
        helper = object : SQLiteOpenHelper(app, NAME, null, 1) {
            override fun onConfigure(db: SQLiteDatabase) {
                db.setForeignKeyConstraintsEnabled(true)
                db.enableWriteAheadLogging()
            }
            override fun onCreate(db: SQLiteDatabase) {}
            override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {}
            // Idempotent, so it also brings a seeded (older) database up to date.
            override fun onOpen(db: SQLiteDatabase) = ensureSchema(db)
        }
    }

    val db: SQLiteDatabase get() = helper.writableDatabase

    private fun seedIfFirstRun(ctx: Context) {
        val file = ctx.getDatabasePath(NAME)
        if (file.exists()) return
        val seed = try { ctx.assets.open("seed.sqlite") } catch (_: Exception) { return }
        file.parentFile?.mkdirs()
        seed.use { input -> File(file.path).outputStream().use { input.copyTo(it) } }
    }

    fun all(sql: String, vararg args: Any?): List<Row> =
        db.rawQuery(sql, args.map { it?.toString() }.toTypedArray()).use { c ->
            buildList { while (c.moveToNext()) add(readRow(c)) }
        }

    fun one(sql: String, vararg args: Any?): Row? = all(sql, *args).firstOrNull()

    fun exec(sql: String, vararg args: Any?) = db.execSQL(sql, args)

    // Returns the number of changed rows (like better-sqlite3's info.changes).
    fun changes(sql: String, vararg args: Any?): Int =
        db.compileStatement(sql).use { st ->
            args.forEachIndexed { i, a -> bind(st, i + 1, a) }
            st.executeUpdateDelete()
        }

    fun insert(sql: String, vararg args: Any?): Long =
        db.compileStatement(sql).use { st ->
            args.forEachIndexed { i, a -> bind(st, i + 1, a) }
            st.executeInsert()
        }

    private fun bind(st: android.database.sqlite.SQLiteStatement, i: Int, a: Any?) = when (a) {
        null -> st.bindNull(i)
        is Long -> st.bindLong(i, a)
        is Int -> st.bindLong(i, a.toLong())
        is Boolean -> st.bindLong(i, if (a) 1 else 0)
        is Double -> st.bindDouble(i, a)
        else -> st.bindString(i, a.toString())
    }

    private fun readRow(c: Cursor): Row = (0 until c.columnCount).associate { i ->
        c.getColumnName(i) to when (c.getType(i)) {
            Cursor.FIELD_TYPE_NULL -> null
            Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
            Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
            else -> c.getString(i)
        }
    }

    private fun ensureSchema(db: SQLiteDatabase) {
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS goals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              sort_order INTEGER NOT NULL DEFAULT 0,
              kind TEXT NOT NULL DEFAULT 'check',
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )""")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
              date TEXT NOT NULL,
              done INTEGER NOT NULL DEFAULT 0,
              time TEXT,
              bed_time TEXT,
              wake_time TEXT,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(goal_id, date)
            )""")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date)")
        db.execSQL("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS presence (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              started_at TEXT NOT NULL,
              ended_at TEXT,
              bed_at TEXT,
              bed_date TEXT
            )""")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_presence_started ON presence(started_at)")
        // App-only: timed app/site blocks added in the UI (see Blocks.kt).
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS blocks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              apps TEXT NOT NULL DEFAULT '[]',
              sites TEXT NOT NULL DEFAULT '[]',
              days TEXT NOT NULL DEFAULT '1234567',
              start_time TEXT NOT NULL,
              end_time TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )""")
        // App-only: screen time + the activity log.
        // `day` is the life day (it starts at DAY_START, 05:00).
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS usage (
              day TEXT NOT NULL,
              key TEXT NOT NULL,          -- app:<package> or site:<domain>
              seconds INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (day, key)
            )""")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              at TEXT NOT NULL,           -- local HH:mm
              day TEXT NOT NULL,
              kind TEXT NOT NULL,         -- blocked, break, tamper, limit
              target TEXT,
              detail TEXT
            )""")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_events_day ON events(day)")

        fun addColumn(table: String, col: String, def: String) {
            val has = db.rawQuery("PRAGMA table_info($table)", null).use { c ->
                val nameIdx = c.getColumnIndexOrThrow("name")
                generateSequence { if (c.moveToNext()) c.getString(nameIdx) else null }.any { it == col }
            }
            if (!has) db.execSQL("ALTER TABLE $table ADD COLUMN $col $def")
        }
        addColumn("logs", "ran", "INTEGER NOT NULL DEFAULT 0")
        addColumn("logs", "worked_out", "INTEGER NOT NULL DEFAULT 0")
        addColumn("logs", "asleep_minutes", "INTEGER")
        addColumn("logs", "up_time", "TEXT")
        addColumn("logs", "sleep_time", "TEXT")
        addColumn("goals", "is_private", "INTEGER NOT NULL DEFAULT 0")
        // One-off blocks (bedtime review): on until this local date-time.
        addColumn("blocks", "until_at", "TEXT")

        // Fresh database: the four default goals plus the "things to avoid".
        val count = db.rawQuery("SELECT COUNT(*) FROM goals", null).use { it.moveToFirst(); it.getLong(0) }
        if (count == 0L) {
            val defaults = listOf(
                Triple("Exercise", "exercise", 0), Triple("Meditation", "check", 0),
                Triple("Yoga", "check", 0), Triple("Sleep", "sleep", 0),
                Triple("Porn", "avoid", 1), Triple("Masturbation", "avoid", 1),
                Triple("YouTube", "avoid", 0), Triple("Nicotine", "avoid", 0), Triple("Alcohol", "avoid", 0),
            )
            defaults.forEachIndexed { i, (name, kind, priv) ->
                db.execSQL("INSERT INTO goals (name, sort_order, kind, is_private) VALUES (?, ?, ?, ?)", arrayOf(name, i, kind, priv))
            }
            // Mark the server's one-time migrations as done — this data is already in the new shape.
            for (k in listOf("mig_exercise_v1", "mig_sleep_bedday_v1", "mig_avoid_seed_v1")) {
                db.execSQL("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')", arrayOf(k))
            }
        }
    }

    // --- meta (server/src/meta.js) ---
    fun getMeta(key: String): String? = one("SELECT value FROM meta WHERE key = ?", key)?.get("value") as String?

    fun setMeta(key: String, value: Any?) = exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key, value?.toString(),
    )

    fun deleteMeta(key: String) = exec("DELETE FROM meta WHERE key = ?", key)
}
