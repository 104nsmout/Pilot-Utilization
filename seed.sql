-- =====================================================================
-- Crew Workload — starting data. Run once, after schema.sql.
-- 1) Change the emails at the bottom to real ones before running.
-- 2) Bases come from the October pivot table. Fix any that changed.
-- =====================================================================

insert into roster (name, display_name, base, on_board) values
  ('Larrea, Wilhen',        'Wilhen Larrea',        'Akron, Ohio',         true),
  ('Jacobs, Andrew',        'Andrew Jacobs',        'Akron, Ohio',         true),
  ('Cirrincione, Anthony',  'Anthony Cirrincione',  'Birmingham, Alabama', true),
  ('Peterson, Emmanuel',    'Emmanuel Peterson',    'Birmingham, Alabama', true),
  ('Cahill, Todd',          'Todd Cahill',          'Denver, Colorado',    true),
  ('Delis, Zale',           'Zale Delis',           'Heber, Utah',         true),
  ('Gerritsen, Greg',       'Greg Gerritsen',       'Heber, Utah',         true),
  ('Kotyk, Zackary',        'Zackary Kotyk',        'Heber, Utah',         true),
  ('Rowser, Brandon',       'Brandon Rowser',       'Heber, Utah',         true),
  ('Kelley, Chris',         'Chris Kelley',         'Heber, Utah',         true),
  ('Nielsen, Kyle',         'Kyle Nielsen',         'Heber, Utah',         true),
  ('Smout, Nicholas',       'Nicholas Smout',       'Heber, Utah',         true),
  ('Tew, Brady',            'Brady Tew',            'Heber, Utah',         true),
  ('Knight, Tyler',         'Tyler Knight',         'Heber, Utah',         true),
  ('Provost, Matthew',      'Matthew Provost',      'Heber, Utah',         true),
  ('Tew, Bridger',          'Bridger Tew',          'Heber, Utah',         true),
  ('Rottmann, Michael',     'Michael Rottmann',     'Houston, Texas',      true),
  ('Coffey, Benjamin',      'Benjamin Coffey',      'Houston, Texas',      true),
  ('Androl, Garrick David', 'Garrick Androl',       'Houston, Texas',      true),
  ('Meier, Matthew',        'Matthew Meier',        'Houston, Texas',      true),
  ('Cook, Justin',          'Justin Cook',          'Houston, Texas',      true),
  ('Walton, James',         'James Walton',         'Houston, Texas',      true),
  ('Rutledge, Jason',       'Jason Rutledge',       'Houston, Texas',      true),
  ('Ramby, Chris',          'Chris Ramby',          'Houston, Texas',      true),
  ('Curry, Anthony',        'Anthony Curry',        'Houston, Texas',      true),
  ('Duggan, Doug',          'Doug Duggan',          'Houston, Texas',      true),
  ('Rosato, Nick',          'Nick Rosato',          'Houston, Texas',      true),
  ('Bufford, James',        'James Bufford',        'Houston, Texas',      true),
  -- Seen in the exports but not on the October board. Hidden until you
  -- give them a base and switch them on from the upload page.
  ('Bertagna, Barron',       'Barron Bertagna',  null, false),
  ('Nylander, Drew',         'Drew Nylander',    null, false),
  ('Smith, Conner',          'Conner Smith',     null, false),
  ('Speers, Bryce',          'Bryce Speers',     null, false),
  ('Sherman, Taylor',        'Taylor Sherman',   null, false),
  ('Taylor, Pete',           'Pete Taylor',      null, false),
  ('Burklund, Joel',         'Joel Burklund',    null, false),
  ('Lee, William Robert',    'William Lee',      null, false),
  ('Lippi, Steven',          'Steven Lippi',     null, false),
  ('Scheipsmeier, Austin',   'Austin Scheipsmeier', null, false),
  ('West, Sarah',            'Sarah West',       null, false),
  ('Bell, Alexander',        'Alexander Bell',   null, false),
  ('Elkins, William Bryant', 'William Elkins',   null, false),
  ('Nemcek, Benjamin',       'Benjamin Nemcek',  null, false)
on conflict (name) do update
  set display_name = excluded.display_name, base = excluded.base, on_board = excluded.on_board;

-- Who can log in. 'admin' can upload and edit the roster; 'viewer' can only look.
insert into app_users (email, role) values
  ('YOUR-EMAIL@example.com',  'admin'),
  ('GREG-EMAIL@example.com',  'viewer')
on conflict (email) do update set role = excluded.role;
