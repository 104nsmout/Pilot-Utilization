# Crew Workload

A web app that shows who is carrying the most and least workload, measured
against the fleet average, for the last 30, 60 or 90 days, year to date, or
12 months. Data comes from Airplane Manager CSV exports that you upload about
twice a week.

## How it fits together

```
Airplane Manager ──CSV──▶ admin.html (upload page) ──▶ Supabase (database) ──▶ index.html (Greg's board)
```

| File | What it does |
|---|---|
| `index.html` + `js/board.js` | The board. Reads data, counts days, draws everything. |
| `admin.html` + `js/admin.js` | Upload page and roster editor. Admins only. |
| `importer.js` | Turns the exports into one row per pilot per day. No network; testable on its own. |
| `js/data.js` | Sign-in and data loading, shared by both pages. |
| `config.js` | Your Supabase address and public key. The only file you must edit. |
| `css/style.css` | Look and feel, light and dark. |
| `schema.sql` | Creates the tables, access rules and upload function. |
| `seed.sql` | Starting roster (bases from the October pivot) and who can log in. |
| `test/run-importer.js` | Runs the importer on real exports from the command line (optional). |

There is no build step. Vercel serves these files exactly as they are, the same
way your fuel app works.

---

## One-time setup (about 30 minutes)

### 1. Create the database (Supabase)
1. Go to supabase.com → **New project**. Name it `crew-workload`. Save the database password somewhere safe.
2. When it finishes, open **SQL Editor → New query**. Paste all of `schema.sql` and press **Run**. You should see "Success".
3. Open `seed.sql`. Replace `YOUR-EMAIL@example.com` with your email and `GREG-EMAIL@example.com` with Greg's. Paste it into a new query and **Run**.
   - Need more viewers later? Run: `insert into app_users (email, role) values ('name@company.com', 'viewer');`
4. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.

### 2. Point the app at it
Open `config.js` and paste those two values in place of the placeholders.
Never paste the **service_role** key anywhere in this project.

### 3. Put the code on GitHub
1. github.com → **New repository** → name `crew-workload` → **Private** → Create.
2. **Add file → Upload files**. Drag in everything from this folder, keeping the
   `css`, `js` and `supabase` folders. Commit.

### 4. Publish it (Vercel)
1. vercel.com → **Add New → Project** → import `crew-workload`.
2. Framework preset: **Other**. Leave build settings empty. **Deploy**.
3. Copy the address Vercel gives you, for example `https://crew-workload.vercel.app`.

### 5. Let sign-in links come back to your site
Supabase → **Authentication → URL Configuration**:
- **Site URL**: your Vercel address.
- **Redirect URLs**: add `https://YOUR-SITE.vercel.app/**`.

Without this, the emailed sign-in link sends people to the wrong place.

### 6. First upload
1. Open `https://YOUR-SITE.vercel.app/admin.html`, enter your email, and click the link in your inbox.
2. Drop in the exports (see the routine below) and press **Save to board**.
3. Open the board at the main address.

---

## The twice-a-week routine (2–3 minutes)

1. In Airplane Manager, export these for the **last 30 days through today**. The overlap with your last upload is fine and keeps things accurate:
   - **Crew legs**: the report with *Crew Name, Flight (Trip) Number, Aircraft Tail…*
   - **Leg detail**: the report with *Leg Order, Arrival Date/Time Local, Flight Time (HR)…*
   - **Schedule entries**: *Staff Name, Type, Start Local, End Local…* Export these **through the end of next month**, so upcoming vacation and training show on pilot profiles.
2. Open `admin.html` and drop all three files in at once. **Keep Airplane Manager's file names.** The dates in the name tell the page which days the file covers.
3. Read section 2 on the page: date ranges, day counts, and any warnings such as a new name.
4. Press **Save to board**.

### Why re-uploading is safe
Each save first clears that file type's days **in that date range**, then writes
the new ones, in a single step. Uploading the same file twice gives the same
result. And if a trip or vacation was removed in Airplane Manager, it disappears
from the board too. Flights and schedule entries are stored separately, so a
flight upload never erases vacation, and vice versa.

---

## Backfilling history

The 90-day, YTD and 12-month views are only as good as the history you've loaded.
Export the same three reports **one month at a time** going back to January (or 12
months back), then upload each month. Order doesn't matter.

Your first loads cover flights Oct 1–Nov 11 and schedule entries Nov 1–30.
**October schedule entries are still missing**, so October training and travel
are counted as days off until you upload them. The board warns about this.

---

## How days are counted

Each pilot gets one category per day. If two things land on the same day, the
first one in this list wins:

**Flying › Training › Travel › Office › Standby › Layover › Sick › Vacation › Other**

- **Duty days** = Flying + Training + Travel + Office + Standby + Layover.
- **Layover** is *inferred*: days between two of a pilot's legs on the same trip.
  Gaps longer than 4 days are treated as the pilot going home (`maxLayoverGap` in `importer.js`).
- **Fleet average** is the average across pilots with **On board** checked.
- **Data through** is the last day of your latest flight upload, so days you
  haven't uploaded yet never look like days off.

Known limits:
- Airplane Manager's own "days worked" (Crew Schedule Summary) can differ by a
  day or two, mainly where a pilot went home in the middle of a multi-day trip.
- Schedule types the page doesn't recognize are saved as **Other** (not duty), and
  the upload page lists them. Add them to `TYPE_MAP` in `importer.js`.

## Roster

The bottom of `admin.html` lists every pilot the exports have mentioned. Check
**On board** and fill in **Base** to put someone on the board. New names from an
upload are added unchecked, so pilots from other operations never appear by accident.

## Who sees what

- Only emails in the `app_users` table can see anything. Signing in alone isn't enough.
- `viewer` = board only. `admin` = board, uploads and roster.
- Keep the GitHub repository **private**. The code holds no crew data, but there's no reason to publish it.

## Testing the importer without the website (optional)

```
npm install papaparse@5.4.1
node test/run-importer.js path/to/crew-legs.csv path/to/leg-detail.csv path/to/schedule.csv
```
It prints the days found per category plus any warnings, which helps when
Airplane Manager changes an export.
