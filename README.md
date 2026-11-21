# Anonymous Party

A private multiplayer party game. Built with Node.js, Express, Socket.IO, HTML, CSS, and vanilla JavaScript.

## Run locally

1. Install Node.js 20 or newer, including npm.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Visit http://localhost:3000.

Copy `.env.example` to `.env` to customize the port and room expiration time. To enable photo uploads, add your Supabase project URL and service-role key to `.env`; never put the service-role key in frontend code or share it publicly.

## Supabase Storage setup

1. In Supabase, create a **private** Storage bucket named `party-photos` (or set `SUPABASE_STORAGE_BUCKET` to another bucket name).
2. Set the bucket's allowed MIME types to `image/jpeg`, `image/png`, and `image/webp`, and set its file size limit to 64 KB.
3. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET=party-photos` to the server's `.env` file.
4. Restart the server. The service-role key stays server-side; the server uploads images and gives room participants a temporary signed URL. Removing a photo deletes its object from Storage.

The server uses `@supabase/supabase-js`. The storage bucket must remain private; the service-role key bypasses Storage RLS and must only be configured as a server secret.

## Included games

- **Who’s Most Likely?** — anonymous player-to-player votes, hidden until the round closes.
- **Smash or Pass** — opt-in photo submission, Smash/Pass voting, photo removal, and in-room reporting.
- **Unpopular Opinions** — anonymous Agree/Disagree voting and percentage results.
- **Expose Your Friends** — player selection, skip option, and hidden results.
- **Anonymous Confessions** — anonymous text submissions, optional author reveal, and preset emoji reactions.

All game rounds use the same invitation and session leaderboard. The host starts each round manually. Scoring awards participation points and a bonus when a player chooses the sole top-voted person in player-selection rounds.

## Current limitations

Room/session state remains in server memory and disappears when the server restarts. Supabase Storage is supported for photos when configured, but Supabase database persistence, robust moderation, and production deployment are not configured. Photo reports currently remove a photo after two in-room reports; they are not sent to a moderation service. Photos in a configured bucket should also be deleted by a scheduled cleanup process after room expiry in a production deployment.

## Verification

JavaScript syntax checks passed. A live multiplayer test was not run in the build environment because npm and installed dependencies were unavailable.
