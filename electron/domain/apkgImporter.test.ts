import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ApkgImporter } from './apkgImporter'
import { AppServices } from './appServices'
import { OnamiDatabase } from './database'

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-test-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const encodeVarint = (value: number): Buffer => {
  const bytes: number[] = []
  let next = value
  while (next >= 0x80) {
    bytes.push((next & 0x7f) | 0x80)
    next = Math.floor(next / 128)
  }
  bytes.push(next)
  return Buffer.from(bytes)
}

const protoString = (fieldNumber: number, value: string): Buffer => {
  const content = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(content.length), content])
}

const createFixtureApkg = (): string => {
  const sourceDir = path.join(tempDir, 'apkg-source')
  fs.mkdirSync(sourceDir)
  const collectionPath = path.join(sourceDir, 'collection.anki2')
  const db = new Database(collectionPath)
  const model = {
    id: 30,
    name: 'Basic',
    type: 0,
    flds: [
      { name: 'Front', ord: 0 },
      { name: 'Back', ord: 1 },
    ],
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{Front}}<hr>{{Back}}',
      },
    ],
  }
  const decks = {
    20: {
      id: 20,
      name: 'Biology::Cells',
    },
  }
  db.exec(`
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    );
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld integer NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE revlog (
      id integer PRIMARY KEY,
      cid integer NOT NULL,
      usn integer NOT NULL,
      ease integer NOT NULL,
      ivl integer NOT NULL,
      lastIvl integer NOT NULL,
      factor integer NOT NULL,
      time integer NOT NULL,
      type integer NOT NULL
    );
  `)
  db.prepare('INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)')
    .run(1_700_000_000, '{}', JSON.stringify({ 30: model }), JSON.stringify(decks), '{}', '{}')
  db.prepare('INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, 0, 0, 0, ?)')
    .run(10, 'guid-10', 30, 'tag-one ', '<img src="cell.png">\x1fMitochondria make ATP.', '')
  db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0, 0, 0, 0, 1, 0, 2500, 0, 0, 0, 0, 0, 0, ?)')
    .run(100, 10, 20, 0, '')
  db.close()

  fs.writeFileSync(path.join(sourceDir, 'media'), JSON.stringify({ 0: 'cell.png' }))
  fs.writeFileSync(path.join(sourceDir, '0'), 'fake-image')

  const apkgPath = path.join(tempDir, 'fixture.apkg')
  const zip = new AdmZip()
  zip.addLocalFolder(sourceDir)
  zip.writeZip(apkgPath)
  return apkgPath
}

const createModernFixtureApkg = (): string => {
  const sourceDir = path.join(tempDir, 'modern-apkg-source')
  fs.mkdirSync(sourceDir)

  const placeholderPath = path.join(sourceDir, 'collection.anki2')
  const placeholder = new Database(placeholderPath)
  placeholder.exec(`
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    );
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld integer NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
  `)
  placeholder
    .prepare('INSERT INTO col VALUES (1, 0, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)')
    .run('{}', '{}', '{}', '{}', '{}')
  placeholder
    .prepare('INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, 0, 0, 0, ?)')
    .run(1, 'placeholder', 1, '', 'Please update to the latest Anki version.\x1f', '')
  placeholder
    .prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0, 0, 0, 0, 1, 0, 2500, 0, 0, 0, 0, 0, 0, ?)')
    .run(1, 1, 1, 0, '')
  placeholder.close()

  const modernPath = path.join(sourceDir, 'collection.anki21b')
  const modern = new Database(modernPath)
  modern.exec(`
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    );
    CREATE TABLE decks (
      id integer PRIMARY KEY NOT NULL,
      name text NOT NULL,
      mtime_secs integer NOT NULL,
      usn integer NOT NULL,
      common blob NOT NULL,
      kind blob NOT NULL
    );
    CREATE TABLE notetypes (
      id integer NOT NULL PRIMARY KEY,
      name text NOT NULL,
      mtime_secs integer NOT NULL,
      usn integer NOT NULL,
      config blob NOT NULL
    );
    CREATE TABLE fields (
      ntid integer NOT NULL,
      ord integer NOT NULL,
      name text NOT NULL,
      config blob NOT NULL,
      PRIMARY KEY (ntid, ord)
    );
    CREATE TABLE templates (
      ntid integer NOT NULL,
      ord integer NOT NULL,
      name text NOT NULL,
      mtime_secs integer NOT NULL,
      usn integer NOT NULL,
      config blob NOT NULL,
      PRIMARY KEY (ntid, ord)
    );
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld integer NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
  `)
  modern
    .prepare('INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0, ?, ?, ?, ?, ?)')
    .run(1_700_000_000, '', '', '', '', '')
  modern.prepare('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)').run(1, 'Default', Buffer.alloc(0), Buffer.alloc(0))
  modern
    .prepare('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)')
    .run(200, 'Modern', Buffer.alloc(0), Buffer.alloc(0))
  modern
    .prepare('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)')
    .run(201, 'Modern\x1fDeck', Buffer.alloc(0), Buffer.alloc(0))
  modern
    .prepare('INSERT INTO notetypes VALUES (?, ?, 0, 0, ?)')
    .run(30, 'Modern Basic', protoString(3, '.card { font-family: sans-serif; }'))
  modern.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run(30, 0, 'Front', Buffer.alloc(0))
  modern.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run(30, 1, 'Back', Buffer.alloc(0))
  modern.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run(30, 2, 'RemarksBack', Buffer.alloc(0))
  modern
    .prepare('INSERT INTO templates VALUES (?, ?, ?, 0, 0, ?)')
    .run(30, 0, 'Card 1', Buffer.concat([protoString(1, '{{Front}}'), protoString(2, '{{FrontSide}}<hr>{{Back}}')]))
  modern
    .prepare('INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, 0, 0, 0, ?)')
    .run(10, 'modern-guid', 30, 'modern-tag ', 'Modern front\x1fModern back\x1fEnglish meaning', '')
  modern
    .prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0, 0, 0, 0, 1, 0, 2500, 0, 0, 0, 0, 0, 0, ?)')
    .run(100, 10, 201, 0, '')
  modern.close()

  fs.writeFileSync(path.join(sourceDir, 'media'), '{}')

  const apkgPath = path.join(tempDir, 'modern-fixture.apkg')
  const zip = new AdmZip()
  zip.addLocalFolder(sourceDir)
  zip.writeZip(apkgPath)
  return apkgPath
}

describe('ApkgImporter', () => {
  it('parses a legacy APKG with note fields, card templates, deck hierarchy, and media', () => {
    const importer = new ApkgImporter()
    const parsed = importer.parse(createFixtureApkg())
    try {
      expect(parsed.decks.map((deck) => deck.name)).toEqual(['Biology', 'Cells'])
      expect(parsed.notes).toHaveLength(1)
      expect(parsed.cards).toHaveLength(1)
      expect(parsed.cards[0].frontHtml).toContain('cell.png')
      expect(parsed.media[0].originalName).toBe('cell.png')
    } finally {
      fs.rmSync(parsed.tempDir, { recursive: true, force: true })
    }
  })

  it('prefers modern collection.anki21b over the legacy update-placeholder collection', () => {
    const importer = new ApkgImporter()
    const parsed = importer.parse(createModernFixtureApkg())
    try {
      expect(parsed.decks.map((deck) => deck.name)).toEqual(['Default', 'Modern', 'Deck'])
      expect(parsed.notes).toHaveLength(1)
      expect(parsed.cards).toHaveLength(1)
      expect(parsed.cards[0].deckAnkiId).toBe('201')
      expect(parsed.cards[0].frontHtml).toBe('Modern front')
      expect(parsed.cards[0].backHtml).toContain('Modern front')
      expect(parsed.cards[0].backHtml).toContain('Modern back')
      expect(parsed.cards[0].backHtml).toContain('English meaning')
    } finally {
      fs.rmSync(parsed.tempDir, { recursive: true, force: true })
    }
  })
})

describe('AppServices APKG import', () => {
  it('imports cards and updates existing notes on re-import', () => {
    const apkgPath = createFixtureApkg()
    const database = new OnamiDatabase(path.join(tempDir, 'onami.sqlite'), path.join(tempDir, 'media-store'))
    const services = new AppServices(database)

    const first = services.importApkg(apkgPath, { preserveScheduling: false })
    const second = services.importApkg(apkgPath, { preserveScheduling: false })
    const decks = services.listDecks()
    const importedDeckCards = decks.reduce((sum, deck) => sum + deck.totalCards, 0)

    expect(first.importedCards).toBe(1)
    expect(second.updatedNotes).toBe(1)
    expect(importedDeckCards).toBe(1)
    database.close()
  })
})
