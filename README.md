# Lumora

Lumora is a writing, reading, diary, and social-storytelling web app.

## Current features

- Home page with quick actions for Write a Book, Open Diary, and Share a Thought
- My Books with user-uploaded book covers and individually titled pages/chapters
- Discovery as a visual book grid
- Chika as a vertical public-diary feed
- News Feed for public Share a Thought posts; public thoughts automatically archive after 24 hours, with Archived Thoughts available in Settings
- Share a Thought and Diary visibility: Public, Followers, Friends, or Only Me
- Public/private account setting
- Followers, Following, and automatic Friends when two people follow each other
- Messaging with message requests and configurable message permissions
- Profile editing with avatar upload, bio, cover image, and favorite quote
- Diary photo uploads
- 20+ soft color themes
- Lumora moon-and-star logo
- Search for public books, people, diaries, and posts
- Exact text highlighting and bookmarks in the reader; highlights are hidden until the Highlights control is opened
- Backend privacy enforcement for public/follower/friend/private content
- Email verification before full access


## Authentication fixes in this version

- Login now includes a **Forgot Password?** link beside the account-creation option.
- Password reset uses one-time, hashed reset tokens with a 1-hour expiry and invalidates existing sessions after a successful reset.
- Email verification includes a 6-digit code entry UI with expiry/error handling and a resend-code action.
- The email verification link is served directly by the Node server at `/verify-email`, fixing the previous Render/static-file 404.
- New verification tokens/codes are stored as hashes; older verification records using plaintext fields remain readable for compatibility.
- HTTPS deployments now mark the authentication session cookie as `Secure`.
- Brevo remains the existing SMTP delivery mechanism configured through Render environment variables.


## Run on Windows

Open VS Code in the folder containing `package.json`, then use the VS Code terminal:

```cmd
npm.cmd install
npm.cmd start
```

Open `http://localhost:3000`.

If PowerShell says scripts are disabled, use `npm.cmd` as shown above instead of `npm`.

## Important

Keep your `data/db.json` as a backup while testing new versions. The app automatically adds missing social/privacy fields to older data.

The JSON database is still suitable for local testing, not high-scale production. Before opening Lumora to many real users, move account/content storage to a real database such as PostgreSQL and use production security controls.
### Persistent local data

Lumora stores user data (including follows, messages, books, diaries, posts, and notifications) outside the website source folder by default. On first launch of this version, an existing `data/db.json` is migrated automatically. This prevents replacing the website code from resetting user relationships.

You can override the data location with the `LUMORA_DATA_DIR` environment variable.
