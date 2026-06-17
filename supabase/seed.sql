-- =====================================================
-- AYUS Ops — sample data for first run (optional)
-- Run after schema.sql to see the system working end-to-end.
-- =====================================================

insert into leads (name, email, source, message) values
  ('Rohit Sharma', 'rohit@example.com', 'website', 'Hi, we need a custom PDF tool for our CA firm — merging, splitting and e-sign. What would this cost?'),
  ('Priya Patel', 'priya@example.com', 'instagram', 'Saw your reel. Can you build a landing page + payment for my course?'),
  ('Random User', 'spam@example.com', 'website', 'CHEAP SEO BACKLINKS BUY NOW!!!');

insert into invoices (client_name, client_email, amount, currency, due_date, status) values
  ('Mehta & Associates', 'accounts@example.com', 45000, 'INR', current_date - 7, 'unpaid'),
  ('Skyline Media', 'finance@example.com', 28000, 'INR', current_date + 3, 'unpaid'),
  ('GreenLeaf Organics', 'pay@example.com', 15000, 'INR', current_date + 20, 'unpaid');

insert into content_items (title, platform, draft) values
  ('How one person runs a studio with AI', 'instagram', 'In this reel I show the system that runs AYUS Labs daily — agents for sales, finance and marketing, with me only approving decisions. Built on Supabase and the Claude API.');
