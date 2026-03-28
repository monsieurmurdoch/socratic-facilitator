const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${protocol}://${window.location.host}`;
let ws;

document.getElementById('join-btn').addEventListener('click', () => {
    const code = document.getElementById('session-code').value.trim();
    if (!code) return alert("Enter a code");

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join_dashboard", sessionId: code }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "error") {
            alert(msg.text);
            ws.close();
        } else if (msg.type === "dashboard_joined") {
            document.getElementById('join-section').style.display = 'none';
            document.getElementById('dashboard-content').style.display = 'block';
            document.getElementById('session-title').innerText = `Monitoring Session: ${msg.sessionId}`;
            renderDashboard(msg.snapshot);
        } else if (msg.type === "state_snapshot") {
            renderDashboard(msg.snapshot);
        }
    };
});

function renderDashboard(snapshot) {
    // Update AI Stats
    const aiRatioPct = Math.round((snapshot.aiStats.talkRatio || 0) * 100);
    document.getElementById('ai-ratio').innerText = `${aiRatioPct}%`;
    document.getElementById('ai-ratio-bar').style.width = `${Math.min(aiRatioPct, 100)}%`;
    document.getElementById('ai-count').innerText = snapshot.aiStats.messageCount || 0;

    const lastMove = snapshot.aiStats.messagesSinceLastIntervention === 0 ? "Just spoke" : `${snapshot.aiStats.messagesSinceLastIntervention} msgs ago`;
    document.getElementById('ai-last-move').innerText = lastMove;

    // Update Tension
    const tensionCount = (snapshot.tensions || []).length;
    document.getElementById('tension-level').innerText = tensionCount > 0 ? `${tensionCount} active` : "None";

    // Update Participants
    const participantDiv = document.getElementById('participants-list');
    participantDiv.innerHTML = '';

    const participantList = snapshot.participants || [];
    if (participantList.length === 0) {
        participantDiv.innerHTML = '<p style="color:#aaa;">No participants yet.</p>';
    }

    for (const p of participantList) {
        const totalMsgs = snapshot.totalMessages || 1;
        const pct = Math.round((p.messageCount / totalMsgs) * 100) || 0;

        participantDiv.innerHTML += `
      <div class="stat-row">
        <span>${p.name}</span>
        <span>${pct}% (${p.messageCount} msgs)</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%; background: #3498db;"></div></div>
    `;
    }
}
