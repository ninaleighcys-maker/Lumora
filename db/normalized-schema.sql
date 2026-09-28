CREATE TABLE IF NOT EXISTS lumora_schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS lumora_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  favorite_quote TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'Rose',
  account_privacy TEXT NOT NULL DEFAULT 'public',
  message_permission TEXT NOT NULL DEFAULT 'everyone',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lumora_users_username ON lumora_users(username);
CREATE INDEX IF NOT EXISTS idx_lumora_users_email ON lumora_users(email);

CREATE TABLE IF NOT EXISTS lumora_books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'private',
  font_family TEXT NOT NULL DEFAULT 'Roboto',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_lumora_books_user_updated ON lumora_books(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_books_visibility_updated ON lumora_books(visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS lumora_chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lumora_chapters_book_position ON lumora_chapters(book_id, position);

CREATE TABLE IF NOT EXISTS lumora_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  mention_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_lumora_posts_feed ON lumora_posts(visibility, archived_at, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_posts_user_created ON lumora_posts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_comments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  parent_id TEXT,
  content TEXT NOT NULL,
  mention_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_lumora_comments_target_created ON lumora_comments(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lumora_comments_parent_created ON lumora_comments(parent_id, created_at);

CREATE TABLE IF NOT EXISTS lumora_likes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_likes_target ON lumora_likes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_lumora_likes_user_created ON lumora_likes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_reposts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_reposts_post_created ON lumora_reposts(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_reposts_user_created ON lumora_reposts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL,
  following_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_follows_following ON lumora_follows(following_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_follows_follower ON lumora_follows(follower_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_friendships (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_lumora_friendships_a ON lumora_friendships(user_a);
CREATE INDEX IF NOT EXISTS idx_lumora_friendships_b ON lumora_friendships(user_b);

CREATE TABLE IF NOT EXISTS lumora_messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  content TEXT NOT NULL,
  client_message_id TEXT,
  created_at BIGINT NOT NULL,
  read_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_lumora_messages_pair_created ON lumora_messages(from_id, to_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_messages_pair_reverse ON lumora_messages(to_id, from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_messages_unread ON lumora_messages(to_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_messages_client_id ON lumora_messages(from_id, to_id, client_message_id);

CREATE TABLE IF NOT EXISTS lumora_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  message TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  book_id TEXT,
  created_at BIGINT NOT NULL,
  read_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_lumora_notifications_user_created ON lumora_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_notifications_unread ON lumora_notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_libraries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_libraries_user_created ON lumora_libraries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_libraries_book ON lumora_libraries(book_id);

CREATE TABLE IF NOT EXISTS lumora_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_favorites_user_created ON lumora_favorites(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_favorites_book ON lumora_favorites(book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_reading_progress (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  page_number INTEGER NOT NULL DEFAULT 1,
  scroll_top DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_lumora_reading_progress_user_updated ON lumora_reading_progress(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS lumora_book_reads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lumora_book_reads_book ON lumora_book_reads(book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_book_reads_user_book ON lumora_book_reads(user_id, book_id);

CREATE TABLE IF NOT EXISTS lumora_chapter_reads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lumora_chapter_reads_chapter ON lumora_chapter_reads(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lumora_chapter_reads_user_book ON lumora_chapter_reads(user_id, book_id);

CREATE TABLE IF NOT EXISTS lumora_highlights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  start_pos INTEGER NOT NULL,
  end_pos INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lumora_highlights_user_chapter ON lumora_highlights(user_id, chapter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lumora_bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lumora_bookmarks_user_chapter ON lumora_bookmarks(user_id, chapter_id, created_at DESC);

DO $$
DECLARE
  v JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lumora_schema_meta WHERE version = 1) AND EXISTS (SELECT 1 FROM lumora_state WHERE id = 1) THEN
    SELECT data INTO v FROM lumora_state WHERE id = 1;

    INSERT INTO lumora_users (id,username,name,email,email_verified,bio,avatar_url,cover_url,favorite_quote,theme,account_privacy,message_permission,created_at)
    SELECT x->>'id',x->>'username',COALESCE(x->>'name',''),COALESCE(x->>'email',''),
      COALESCE((x->>'emailVerified')::boolean,false),COALESCE(x->>'bio',''),COALESCE(x->>'avatarUrl',''),
      COALESCE(x->>'coverUrl',''),COALESCE(x->>'favoriteQuote',''),COALESCE(x->>'theme','Rose'),
      COALESCE(x->>'accountPrivacy','public'),COALESCE(x->>'messagePermission','everyone'),
      COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'users','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_books (id,user_id,title,description,cover,genre,tags,visibility,font_family,created_at,updated_at,deleted_at)
    SELECT x->>'id',x->>'userId',COALESCE(x->>'title','Untitled'),COALESCE(x->>'description',''),
      COALESCE(x->>'cover',''),COALESCE(x->>'genre',''),COALESCE(x->'tags','[]'::jsonb),
      COALESCE(x->>'visibility','private'),COALESCE(x->>'fontFamily','Roboto'),
      COALESCE((x->>'createdAt')::bigint,0),COALESCE((x->>'updatedAt')::bigint,COALESCE((x->>'createdAt')::bigint,0)),
      (x->>'deletedAt')::bigint
    FROM jsonb_array_elements(COALESCE(v->'books','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_chapters (id,book_id,title,content,content_html,position)
    SELECT ch->>'id',b->>'id',COALESCE(ch->>'title',''),COALESCE(ch->>'content',''),COALESCE(ch->>'contentHtml',''),ord-1
    FROM jsonb_array_elements(COALESCE(v->'books','[]'::jsonb)) b
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b->'chapters','[]'::jsonb)) WITH ORDINALITY t(ch,ord)
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_posts (id,user_id,content,mention_user_ids,visibility,created_at,updated_at,archived_at,deleted_at)
    SELECT x->>'id',x->>'userId',COALESCE(x->>'content',''),COALESCE(x->'mentionUserIds','[]'::jsonb),
      COALESCE(x->>'visibility','private'),COALESCE((x->>'createdAt')::bigint,0),
      COALESCE((x->>'updatedAt')::bigint,COALESCE((x->>'createdAt')::bigint,0)),
      (x->>'archivedAt')::bigint,(x->>'deletedAt')::bigint
    FROM jsonb_array_elements(COALESCE(v->'posts','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_comments (id,user_id,target_type,target_id,parent_id,content,mention_user_ids,created_at,deleted_at)
    SELECT x->>'id',x->>'userId',COALESCE(x->>'targetType',''),COALESCE(x->>'targetId',''),
      NULLIF(x->>'parentId',''),COALESCE(x->>'content',''),COALESCE(x->'mentionUserIds','[]'::jsonb),
      COALESCE((x->>'createdAt')::bigint,0),(x->>'deletedAt')::bigint
    FROM jsonb_array_elements(COALESCE(v->'comments','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_likes (id,user_id,target_type,target_id,created_at)
    SELECT x->>'id',x->>'userId',COALESCE(x->>'targetType',''),COALESCE(x->>'targetId',''),COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'likes','[]'::jsonb)) x
    ON CONFLICT(user_id,target_type,target_id) DO NOTHING;

    INSERT INTO lumora_reposts (id,user_id,post_id,created_at)
    SELECT x->>'id',x->>'userId',x->>'postId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'reposts','[]'::jsonb)) x
    ON CONFLICT(user_id,post_id) DO NOTHING;

    INSERT INTO lumora_follows (id,follower_id,following_id,created_at)
    SELECT x->>'id',x->>'followerId',x->>'followingId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'follows','[]'::jsonb)) x
    ON CONFLICT(follower_id,following_id) DO NOTHING;

    INSERT INTO lumora_friendships (id,user_a,user_b,created_at)
    SELECT x->>'id',x->>'userA',x->>'userB',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'friendships','[]'::jsonb)) x
    ON CONFLICT(user_a,user_b) DO NOTHING;

    INSERT INTO lumora_messages (id,from_id,to_id,content,client_message_id,created_at,read_at)
    SELECT x->>'id',x->>'fromId',x->>'toId',COALESCE(x->>'content',''),NULLIF(x->>'clientMessageId',''),
      COALESCE((x->>'createdAt')::bigint,0),(x->>'readAt')::bigint
    FROM jsonb_array_elements(COALESCE(v->'messages','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_notifications (id,user_id,type,actor_id,message,target_type,target_id,book_id,created_at,read_at)
    SELECT x->>'id',x->>'userId',COALESCE(x->>'type',''),x->>'actorId',COALESCE(x->>'message',''),
      COALESCE(x->>'targetType',''),COALESCE(x->>'targetId',''),x->>'bookId',
      COALESCE((x->>'createdAt')::bigint,0),(x->>'readAt')::bigint
    FROM jsonb_array_elements(COALESCE(v->'notifications','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_libraries (id,user_id,book_id,created_at)
    SELECT x->>'id',x->>'userId',x->>'bookId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'libraries','[]'::jsonb)) x
    ON CONFLICT(user_id,book_id) DO NOTHING;

    INSERT INTO lumora_favorites (id,user_id,book_id,created_at)
    SELECT x->>'id',x->>'userId',x->>'bookId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'favorites','[]'::jsonb)) x
    ON CONFLICT(user_id,book_id) DO NOTHING;

    INSERT INTO lumora_reading_progress (user_id,book_id,chapter_id,page_number,scroll_top,updated_at)
    SELECT x->>'userId',x->>'bookId',x->>'chapterId',COALESCE((x->>'pageNumber')::integer,1),
      COALESCE((x->>'scrollTop')::double precision,0),COALESCE((x->>'updatedAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'readingProgress','[]'::jsonb)) x
    ON CONFLICT(user_id,book_id) DO NOTHING;

    INSERT INTO lumora_book_reads (id,user_id,book_id,created_at)
    SELECT x->>'id',x->>'userId',x->>'bookId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'bookReads','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_chapter_reads (id,user_id,book_id,chapter_id,created_at)
    SELECT x->>'id',x->>'userId',x->>'bookId',x->>'chapterId',COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'chapterReads','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_highlights (id,user_id,chapter_id,text,note,start_pos,end_pos,created_at)
    SELECT x->>'id',x->>'userId',x->>'chapterId',COALESCE(x->>'text',''),COALESCE(x->>'note',''),
      COALESCE((x->>'start')::integer,0),COALESCE((x->>'end')::integer,0),COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'highlights','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_bookmarks (id,user_id,chapter_id,position,created_at)
    SELECT x->>'id',x->>'userId',x->>'chapterId',COALESCE((x->>'position')::double precision,0),
      COALESCE((x->>'createdAt')::bigint,0)
    FROM jsonb_array_elements(COALESCE(v->'bookmarks','[]'::jsonb)) x
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO lumora_schema_meta(version,applied_at) VALUES (1,(EXTRACT(EPOCH FROM NOW())*1000)::bigint);
  END IF;
END $$;
