# Putting Find My Type on GitHub

One-time setup, then a single command for every update.

> **The repository must be public for in-app updates to work.** The apps ask GitHub's
> public API for the latest release, which doesn't answer for private repositories.

## 1. Create the repository

1. Sign in at github.com → **+** (top right) → **New repository**.
2. Name it, for example `find-my-type`. Choose **Public**.
3. Leave **Add a README**, **.gitignore** and **license** *unticked* — this project already has its files.
4. Click **Create repository**. Keep the page open; you'll need its URL
   (`https://github.com/YOUR-NAME/find-my-type.git`).

## 2. Use your GitHub email for commits (recommended)

So commits show your GitHub account instead of your Mac's local name:

1. GitHub → **Settings → Emails**. Tick **Keep my email addresses private** and copy the
   address that looks like `12345678+YOUR-NAME@users.noreply.github.com`.
2. In Terminal, in this folder:

   ```
   git config user.name "Your Name"
   git config user.email "12345678+YOUR-NAME@users.noreply.github.com"
   ```

## 3. Push the project

```
git remote add origin https://github.com/YOUR-NAME/find-my-type.git
git push -u origin main
git push origin --tags
```

The last line uploads the version history tags (v0-mvp … v9) so you can still go back to any of them.

When Git asks you to sign in, use your GitHub username and a **personal access token**
as the password (GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained → *Generate new token*, give it **Contents: Read and write** on this repository).
Alternatively, install **GitHub Desktop**, choose *File → Add Local Repository*, and click *Publish*.

## 4. Check the builds

Open the repository on GitHub → **Actions**. The **Build** workflow builds the Mac and
Windows apps (about 5 minutes). Both should get a green tick. You can download each build
from the run page under **Artifacts** to try it before releasing.

## 5. Publish the first release

```
app/release.sh 2.1.0
```

When the Actions run finishes, **Releases** shows *v2.1.0* with
`Find-My-Type-Mac.zip` and `Find-My-Type-Windows.zip`. Share the Releases page link with users.

## 6. Every update after that

1. Make and commit your changes.
2. Run `app/release.sh 2.2.0` (next number up).
3. Done. Within a day — or straight away via **Check for Updates…** — every installed copy
   shows *“Find My Type 2.2.0 is available”* with an **Update now** button.

Version numbers: bump the last number for fixes (2.1.1), the middle one for new features (2.2.0).

## Notes

- **Mac:** the app replaces itself in place, so users should keep it in Applications.
  It isn't notarised, so the very first launch needs right-click → **Open**; updates after that don't.
- **Windows:** the app updates its own folder, so it should live in a folder the user owns
  (not Program Files). It isn't code-signed, so SmartScreen may warn on first run.
- To remove those first-launch warnings later you'd need an Apple Developer ID
  (notarisation) and a Windows code-signing certificate.
