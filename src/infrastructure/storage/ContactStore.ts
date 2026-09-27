import { Contact, ContactStore } from '../../application/ContactService';
import { CelesteDatabase } from './Database';

/** Contatos do WhatsApp na tabela contacts do SQLite. */
export class SqliteContactStore implements ContactStore {
  constructor(private database: CelesteDatabase) {}

  loadAll(): Contact[] {
    const rows = this.database
      .getDatabase()
      .prepare('SELECT id, name, push_name, phone_number FROM contacts')
      .all() as Array<{ id: string; name: string | null; push_name: string | null; phone_number: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? undefined,
      pushName: row.push_name ?? undefined,
      phone: row.phone_number ?? undefined,
    }));
  }

  saveMany(contacts: Contact[]): void {
    const db = this.database.getDatabase();
    const statement = db.prepare(
      `INSERT INTO contacts (id, name, push_name, phone_number, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = COALESCE(excluded.name, contacts.name),
         push_name = COALESCE(excluded.push_name, contacts.push_name),
         phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
         updated_at = CURRENT_TIMESTAMP`
    );
    // A sincronização inicial pode trazer centenas de contatos de uma vez: uma transação só.
    db.transaction((items: Contact[]) => {
      for (const c of items) statement.run(c.id, c.name ?? null, c.pushName ?? null, c.phone ?? null);
    })(contacts);
  }
}
