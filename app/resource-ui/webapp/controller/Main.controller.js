sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("resource.agent.ui.controller.Main", {

    onInit: function () {
      this._conversationHistory = [];
      this._employees   = [];
      this._assignments = [];
      this._projects    = [];
      this._setViewRange(0);

      // Wait for DOM then render shell
      setTimeout(() => {
        this._buildShell();
        this._loadAll();
      }, 100);
    },

    // ── Shell ─────────────────────────────────────────────────────────────────

    _buildShell: function () {
      const shell = document.getElementById("app-shell");
      if (!shell) return;

      shell.innerHTML = `
        <div class="appHeader">
          <span class="appTitle">Resource Management Agent</span>
          <div class="headerActions">
            <select id="monthSelector" class="monthSelect">
              <option value="0">This Month</option>
              <option value="1">Next Month</option>
              <option value="2">Next 3 Months</option>
              <option value="3">Next 6 Months</option>
            </select>
            <button class="btnRefresh" onclick="sap.ui.getCore().byId('__xmlview0').getController().onRefresh()">↺ Refresh</button>
          </div>
        </div>
        <div class="appBody">
          <div class="ganttPanel">
            <div class="panelTitle">Team Timeline</div>
            <div id="ganttContent" class="ganttContent"></div>
          </div>
          <div class="chatPanel">
            <div class="panelTitle">
              Agent Chat
              <button class="btnClear" id="clearBtn">Clear</button>
            </div>
            <div id="chatMessages" class="chatMessages"></div>
            <div class="chatInputBar">
              <input id="chatInput" class="chatInput" placeholder="e.g. Who is free next month for a React project?" />
              <button class="btnSend" id="sendBtn">Send ▶</button>
            </div>
          </div>
        </div>`;

      // Events
      document.getElementById("sendBtn").onclick = () => this._sendMessage();
      document.getElementById("clearBtn").onclick = () => this._clearChat();
      document.getElementById("chatInput").onkeydown = (e) => { if (e.key === "Enter") this._sendMessage(); };
      document.getElementById("monthSelector").onchange = (e) => {
        this._setViewRange(parseInt(e.target.value));
        this._renderGantt();
      };
    },

    // ── Data ──────────────────────────────────────────────────────────────────

    _loadAll: function () {
      Promise.all([
        fetch("/api/Employees?$orderby=name&$top=500").then(r => r.json()),
        fetch("/api/Assignments").then(r => r.json()),
        fetch("/api/Projects").then(r => r.json())
      ]).then(([emp, asgn, proj]) => {
        this._employees   = emp.value  || [];
        this._assignments = asgn.value || [];
        this._projects    = proj.value || [];
        this._renderGantt();
      });
    },

    onRefresh: function () { this._loadAll(); },

    // ── Gantt ─────────────────────────────────────────────────────────────────

    _setViewRange: function (offset) {
      const now = new Date();
      this._viewStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const months = [1, 2, 3, 6][offset] || 1;
      this._viewEnd = new Date(now.getFullYear(), now.getMonth() + months + 1, 0);
    },

    _renderGantt: function () {
      const container = document.getElementById("ganttContent");
      if (!container) return;

      const vsMs    = this._viewStart.getTime();
      const veMs    = this._viewEnd.getTime();
      const totalMs = veMs - vsMs;

      const statusColor = { active: "#0854a0", booked: "#d9730d", open: "#6b6b6b" };

      container.innerHTML = this._employees.map(emp => {
        const empAsgns = this._assignments.filter(a => a.employeeId === emp.ID);

        const bars = empAsgns.map(a => {
          const aStart = Math.max(new Date(a.startDate).getTime(), vsMs);
          const aEnd   = Math.min(new Date(a.endDate).getTime(), veMs);
          if (aStart >= aEnd) return "";
          const left  = ((aStart - vsMs) / totalMs * 100).toFixed(1);
          const width = ((aEnd - aStart)  / totalMs * 100).toFixed(1);
          const proj  = this._projects.find(p => p.ID === a.projectId);
          const color = statusColor[proj?.status] || "#aaa";
          const label = proj?.name || "";
          return `<div class="ganttBar" style="left:${left}%;width:${width}%;background:${color}" title="${label}">${label}</div>`;
        }).join("");

        const badgeClass = { senior: "badge-senior", mid: "badge-mid", junior: "badge-junior" }[emp.seniority] || "";

        return `<div class="ganttRow">
          <div class="ganttLabel">
            <span class="empName" title="${emp.name}">${emp.name}</span>
            <span class="empBadge ${badgeClass}">${emp.seniority}</span>
          </div>
          <div class="ganttTrack">${bars || '<span class="freeLabel">Free</span>'}</div>
        </div>`;
      }).join("");
    },

    // ── Chat ──────────────────────────────────────────────────────────────────

    _sendMessage: function () {
      const input = document.getElementById("chatInput");
      const msg = input.value.trim();
      if (!msg) return;
      input.value = "";
      this._appendMessage(msg, "user");
      this._callAgent(msg);
    },

    _clearChat: function () {
      this._conversationHistory = [];
      document.getElementById("chatMessages").innerHTML = "";
    },

    _appendMessage: function (text, role, id) {
      const container = document.getElementById("chatMessages");
      const isUser = role === "user";
      const div = document.createElement("div");
      div.className = "msgRow " + (isUser ? "msgRowUser" : "msgRowAgent");
      if (id) div.id = id;
      div.innerHTML = `<div class="msgBubble ${isUser ? "userBubble" : "agentBubble"}">${this._escapeHtml(text)}</div>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    },

    _escapeHtml: function (str) {
      return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
    },

    _callAgent: function (message) {
      const thinkingId = "thinking-" + Date.now();
      this._appendMessage("Thinking...", "agent", thinkingId);

      fetch("/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationHistory: this._conversationHistory })
      })
        .then(r => r.json())
        .then(data => {
          const el = document.getElementById(thinkingId);
          if (el) el.remove();
          if (data.error) {
            this._appendMessage("Error: " + data.error, "agent");
          } else {
            this._conversationHistory = data.messages || [];
            this._appendMessage(data.reply, "agent");
            if (data.toolsUsed && data.toolsUsed.some(t => ["createAssignment","deleteAssignment","createEmployee","deleteEmployee"].includes(t))) {
              this._loadAll();
            }
          }
        })
        .catch(err => {
          const el = document.getElementById(thinkingId);
          if (el) el.remove();
          this._appendMessage("Network error: " + err.message, "agent");
        });
    }
  });
});
