
# Friend Finder 👥

Track your friends' recurring daily schedules. Sign in with Google and your data syncs across all your devices.

## Features

- **Custom schedules** — Create cycle templates of any length (2–60 days). Mark each day as good, okay, or bad.
- **Per-friend assignment** — Assign any schedule to any friend with a start date.
- **Schedule history** — Change a friend's schedule anytime. Old schedules stay in the past, new ones apply forward.
- **Retroactive first entry** — A friend's first schedule extends infinitely into the past.
- **Calendar views** — Month and week views with color-coded availability dots.
- **Cross-device sync** — Firebase + Google sign-in. Same data on phone and laptop.
- **Landing page** — Animated sign-in page with demo visuals.

---

## Setup Guide (15 minutes)

### Step 1: Create a Firebase Project (free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com/)
2. Click **Add project**, name it anything (e.g. `friend-tracker`)
3. Disable Google Analytics → **Create project**

### Step 2: Enable Google Sign-In

1. Go to **Build → Authentication → Get started**
2. Under **Sign-in method**, click **Google**, toggle **Enable**
3. Select your email as support email → **Save**

### Step 3: Create a Firestore Database

1. Go to **Build → Firestore Database → Create database**
2. Choose **Start in production mode** → pick a region → **Enable**
3. Go to the **Rules** tab and replace with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

4. Click **Publish**

### Step 4: Register a Web App

1. Go to **Project Overview** → gear icon → **Project settings**
2. Scroll to **Your apps** → click the **Web** icon (`</>`)
3. Name it anything → **Register app**
4. Copy the `firebaseConfig` values into `src/firebase.js`

### Step 5: Add Your Domain

1. Go to **Build → Authentication → Settings → Authorized domains**
2. Click **Add domain** → add `YOUR_USERNAME.github.io`

### Step 6: Deploy to GitHub Pages

1. Create a new Public repo at [github.com/new](https://github.com/new) named `friend-tracker`

2. Make sure `base` in `vite.config.js` matches your repo name:
   ```js
   base: '/friend-tracker/',
   ```

3. Push:
   ```bash
   cd friend-tracker-deploy
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/friend-tracker.git
   git push -u origin main
   ```

4. Go to repo → **Settings → Pages** → Source: **GitHub Actions**

5. Live at `https://YOUR_USERNAME.github.io/friend-tracker/` in ~1 minute.

---

## Local Development

```bash
npm install
npm run dev
```

---

## Data Model

Each user document in Firestore (`users/{uid}`) stores:

- **schedules** — Array of schedule templates, each with a name, cycle length, and day status map
- **friends** — Array of friends, each with a schedule history (array of `{scheduleId, cycleStart, changedAt}`)

The first entry in a friend's schedule history applies retroactively to all past dates. Subsequent entries only apply from their start date forward.

---

## Security

- Firestore rules ensure users can only access their own data
- The Firebase API key is a public identifier, not a secret — access is controlled by rules + auth
- No sensitive data stored — just names, emojis, and dates
