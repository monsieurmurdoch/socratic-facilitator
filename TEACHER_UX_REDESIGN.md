# Teacher UX Redesign — Implementation Plan

## Goal
Reduce teacher flow from 4 screens (Dashboard → Setup → Lobby → Video) to 2-3 steps: **Login → Click class → Go Live**. Make classes the central organizing unit with persistent room codes.

## New Flow

```
Teacher signs in
  → Sees class card grid (no Quick Session / Join By Code clutter)
  → Clicks a class card → expands inline showing:
     - Persistent room code (copyable)
     - Live status
     - If live: "Join Live Session" button
     - If not live: inline "Start Today's Discussion" (title, question, materials)
     - Collapsed session timeline
  → Clicks "Go Live" → Lobby → Video
  → Or clicks "Join Live" → Video directly
```

## Phases (in order)

### Phase 1: History / Back Button
**Files:** `client/src/app.js`

- Add `navigateTo(screen)` that calls `showScreen()` + `history.pushState()`
- Add `popstate` listener that restores the previous screen
- Replace bare `showScreen('lobby')` and `showScreen('video')` calls with `navigateTo()`
- Browser back from Video → Lobby → Welcome with class card still expanded

### Phase 2: Persistent Class Room Codes
**Files:** `server/db/schema.sql`, `server/db/repositories/classes.js`, `server/routes/classes.js`, `server/websocket/handlers.js`

- Add `room_code VARCHAR(12) UNIQUE` column to `classes` table
- Auto-generate a readable room code on class creation (e.g. `plato-9th-grade`)
- Add `ALTER TABLE IF EXISTS classes ADD COLUMN IF NOT EXISTS room_code VARCHAR(12)`
- Add `findByRoomCode()` to classes repo
- Add `GET /api/classes/resolve/:code` that returns the class + any active session
- When student joins by room code (via WebSocket `join_session`), resolve it to the class → active session. If no active session, show "not live yet"

### Phase 3: Remove Quick Session / Join By Code from Teacher Dashboard
**Files:** `client/public/index.html`, `client/src/app.js`

- Remove the `div.session-action-bar` (Create Room / Join Existing) from `#dashboard-teacher`
- Remove associated event listeners (`create-btn-teacher`, `join-toggle-btn-teacher`, etc.)
- Guest panel on landing page keeps Quick Session / Join By Code unchanged

### Phase 4: Class Card Grid + Create Class Modal
**Files:** `client/public/index.html`, `client/src/app.js`, `client/src/style.css`

- Replace the current Saved Classes collapsible + Class Room card with a grid of class cards
- Each collapsed card shows: name, room code, session count, live indicator
- Add "+ New Class" button (top right of dashboard) that opens a centered modal
- Move the class creation form into the modal (reuse existing field IDs)
- Add `expandedClassId` state — clicking a card expands it (spanning full width)
- Drag-and-drop reorder still works on collapsed cards

### Phase 5: Expanded Class Card (inline session launcher)
**Files:** `client/public/index.html`, `client/src/app.js`, `client/src/style.css`

When a class card is expanded, it shows:
- **Left column:** Room code (copyable), class info, live status, edit/collapse buttons
- **Right column (if no live session):**
  - Title input (pre-filled with `{ClassName} Discussion`)
  - Opening question textarea
  - Compact "+ Add Materials" panel (drop zone + URL input, reuses existing `materials` array)
  - "Go Live" button → creates session via REST, joins via WS, navigates to lobby
- **Right column (if live session):**
  - "Join Live Session" button → joins existing session, navigates to video
  - Session title and participant count
- **Bottom:** Collapsed session timeline scoped to this class (most recent 3, "See All")

### Phase 6: Session Timeline Improvements
**Files:** `client/src/app.js`, `client/src/style.css`

- Entries collapsed by default: show only session title + date/time + status badge
- Click to expand: stats, summary, analytics button
- Search bar widened to 100%
- Scope timeline to selected class when a class is expanded

### Phase 7: Auto-End Inactive Sessions
**Files:** `server/websocket/handlers.js`

- When all clients disconnect from a session, the 30s grace period already exists
- Extend: if session has been active with 0 participants for 10 minutes, auto-end it
- Save transcript, mark status `ended`, clean up

### Phase 8: Cleanup
- Remove dead code for old teacher dashboard layout
- Ensure guest flow still works (Quick Session → Setup → Lobby → Video)
- Mobile responsive for expanded class cards (single column)
- Defer: email notifications, student "Active Classes" tab

## Files Modified (summary)

| File | Changes |
|------|---------|
| `client/public/index.html` | Remove action bar from teacher dashboard, add create-class modal, add expanded card template |
| `client/src/app.js` | `navigateTo()` + history, `renderClassCards()`, `renderExpandedClassCard()`, `handleGoLive()`, `handleJoinLive()`, inline materials, popstate |
| `client/src/style.css` | Class card grid, expanded card layout, modal styles, collapsed timeline, responsive |
| `server/db/schema.sql` | `room_code` column on classes |
| `server/db/repositories/classes.js` | `findByRoomCode()`, generate room code on create |
| `server/routes/classes.js` | Room code resolution endpoint |
| `server/websocket/handlers.js` | Room code → session resolution on join, auto-end timer |
