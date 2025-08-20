#!/usr/bin/env node

import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { debugLog } from './debug.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager, SessionInfo, SessionData } from './session-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const WAIT_TIMEOUT_SECONDS = 60;
const HTTP_PORT = process.env.MCP_VOICE_HOOKS_PORT ? parseInt(process.env.MCP_VOICE_HOOKS_PORT) : 5111;
const AUTO_DELIVER_VOICE_INPUT = process.env.MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT !== 'false'; // Default to true (auto-deliver enabled)
const AUTO_DELIVER_VOICE_INPUT_BEFORE_TOOLS = process.env.MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT_BEFORE_TOOLS === 'true'; // Default to false (don't auto-deliver voice input before tools. Only effective if auto-deliver is enabled)

// Multi-instance support
const INSTANCE_ROLE = process.env.ROLE || 'primary';
const INSTANCE_URL = process.env.INSTANCE_URL || `http://127.0.0.1:${HTTP_PORT}`;
const PRIMARY_URL = process.env.PRIMARY_URL || 'http://127.0.0.1:5111';
const DISABLE_UI = process.env.MCP_VOICE_HOOKS_DISABLE_UI === '1';

// Promisified exec for async/await
const execAsync = promisify(exec);

// Function to play a sound notification
async function playNotificationSound() {
  try {
    // Use macOS system sound
    await execAsync('afplay /System/Library/Sounds/Funk.aiff');
    debugLog('[Sound] Played notification sound');
  } catch (error) {
    debugLog(`[Sound] Failed to play sound: ${error}`);
    // Don't throw - sound is not critical
  }
}

// Shared utterance queue
interface Utterance {
  id: string;
  text: string;
  timestamp: Date;
  status: 'pending' | 'delivered' | 'responded';
}

class UtteranceQueue {
  utterances: Utterance[] = [];

  add(text: string, timestamp?: Date): Utterance {
    const utterance: Utterance = {
      id: randomUUID(),
      text: text.trim(),
      timestamp: timestamp || new Date(),
      status: 'pending'
    };

    this.utterances.push(utterance);
    debugLog(`[Queue] queued: "${utterance.text}"	[id: ${utterance.id}]`);
    return utterance;
  }

  getRecent(limit: number = 10): Utterance[] {
    return this.utterances
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  markDelivered(id: string): void {
    const utterance = this.utterances.find(u => u.id === id);
    if (utterance) {
      utterance.status = 'delivered';
      debugLog(`[Queue] delivered: "${utterance.text}"	[id: ${id}]`);
    }
  }

  clear(): void {
    const count = this.utterances.length;
    this.utterances = [];
    debugLog(`[Queue] Cleared ${count} utterances`);
  }
}

// Determine if we're running in MCP-managed mode
const IS_MCP_MANAGED = process.argv.includes('--mcp-managed');

// Global state
const sessionManager = new SessionManager();
// Keep the old queue for backward compatibility during transition
const queue = new UtteranceQueue();

// Set up session change notifications
sessionManager.setChangeCallback(() => {
  notifySessionUpdate();
});
let lastToolUseTimestamp: Date | null = null;
let lastSpeakTimestamp: Date | null = null;

// Voice preferences (controlled by browser)
let voicePreferences = {
  voiceResponsesEnabled: false,
  voiceInputActive: false
};

// HTTP Server Setup (always created)
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Session-to-instance mapping for routing ASR requests
const sessionToInstance = new Map<string, string>();

// Create HTTP server for WebSocket support
const server = http.createServer(app);
let wss: WebSocketServer | null = null;

// Initialize WebSocket server for Primary instances
if (INSTANCE_ROLE === 'primary') {
  wss = new WebSocketServer({ server, path: "/ws" });
  debugLog(`[WebSocket] Initialized WebSocket server for primary instance`);
}

// Serve static files only if UI is enabled
if (!DISABLE_UI) {
  app.use(express.static(path.join(__dirname, '..', 'public')));
}

// Broadcast function for WebSocket clients (Primary only)
function broadcastAll(payload: any) {
  if (wss && INSTANCE_ROLE === 'primary') {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }
}

// Function to lookup instance URL for a session
async function lookupInstanceUrl(sessionId: string): Promise<string | null> {
  return sessionToInstance.get(sessionId) || INSTANCE_URL; // fallback to current instance
}

// Function to register session mapping
function registerSession(sessionId: string, instanceUrl: string) {
  sessionToInstance.set(sessionId, instanceUrl);
  debugLog(`[Session Mapping] Registered ${sessionId} -> ${instanceUrl}`);
}

// Primary hub endpoint for collecting speak events from all instances
app.post('/feed/speak', (req: Request, res: Response) => {
  if (INSTANCE_ROLE !== 'primary') {
    res.status(403).json({ error: 'Only primary instance can accept speak events' });
    return;
  }

  const evt = {
    type: 'speak',
    at: Date.now(),
    sessionId: req.body.sessionId ?? 'unknown',
    instanceUrl: req.body.instanceUrl ?? INSTANCE_URL,
    text: req.body.text ?? req.body.message ?? '',
    meta: req.body.meta ?? {},
  };
  
  // Broadcast to WebSocket clients
  broadcastAll(evt);
  debugLog(`[Event Hub] Broadcasted speak event from session ${evt.sessionId}`);
  
  res.json({ ok: true });
});

// Version/health endpoint
app.get('/version', (_req: Request, res: Response) => {
  res.json({
    role: INSTANCE_ROLE,
    port: HTTP_PORT,
    instanceUrl: INSTANCE_URL,
    primaryUrl: INSTANCE_ROLE === 'secondary' ? PRIMARY_URL : undefined,
    uiDisabled: DISABLE_UI,
    pid: process.pid,
    node: process.version
  });
});

// Enhanced session info endpoint
app.get('/api/sessions/:sessionId/details', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    // Get Git information if in a Git repository
    let gitInfo = null;
    if (session.projectPath) {
      try {
        const { stdout: branch } = await execAsync('git branch --show-current', { cwd: session.projectPath });
        const { stdout: commit } = await execAsync('git rev-parse --short HEAD', { cwd: session.projectPath });
        const { stdout: status } = await execAsync('git status --porcelain', { cwd: session.projectPath });
        
        gitInfo = {
          branch: branch.trim(),
          commit: commit.trim(),
          hasChanges: status.trim().length > 0,
          changedFiles: status.trim().split('\n').filter(line => line.trim()).length
        };
      } catch {
        // Not a git repository or git not available
      }
    }

    res.json({
      ...session,
      gitInfo,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        cwd: session.projectPath || process.cwd()
      }
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get session details',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Session activity timeline
app.get('/api/sessions/:sessionId/activity', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Get activity from utterances (can be extended to include tool usage, etc.)
  const activities = session.utteranceQueue.utterances.map(utterance => ({
    type: 'voice_input',
    timestamp: utterance.timestamp,
    status: utterance.status,
    content: utterance.text,
    id: utterance.id
  }));

  res.json({
    sessionId,
    activities: activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  });
});

// Global activity feed (all sessions)
app.get('/api/activity', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const allSessions = sessionManager.getAllSessions();
  const allActivities: any[] = [];

  // Collect activities from all sessions
  allSessions.forEach(session => {
    session.utteranceQueue.utterances.forEach(utterance => {
      allActivities.push({
        type: 'voice_input',
        timestamp: utterance.timestamp,
        status: utterance.status,
        content: utterance.text,
        id: utterance.id,
        sessionId: session.id,
        sessionName: session.projectName,
        projectPath: session.projectPath
      });
    });
  });

  // Sort by timestamp and limit
  const sortedActivities = allActivities
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  res.json({
    activities: sortedActivities,
    totalSessions: allSessions.length,
    activeSessions: allSessions.filter(s => s.isActive).length
  });
});

// System overview endpoint
app.get('/api/system', (req: Request, res: Response) => {
  const sessions = sessionManager.getAllSessions();
  const summary = sessionManager.getSessionSummary();
  
  res.json({
    instance: {
      role: INSTANCE_ROLE,
      port: HTTP_PORT,
      pid: process.pid,
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform
    },
    sessions: {
      total: sessions.length,
      active: sessions.filter(s => s.isActive).length,
      summary
    },
    voice: {
      enabled: !DISABLE_UI,
      activeClients: ttsClients.size
    },
    memory: process.memoryUsage()
  });
});

// ASR routing endpoint (Primary only) - routes mic input to correct instance
app.post('/ui/asr/:sessionId', async (req: Request, res: Response) => {
  if (INSTANCE_ROLE !== 'primary') {
    res.status(403).json({ error: 'ASR routing only available on primary instance' });
    return;
  }

  const sessionId = req.params.sessionId;
  const instanceUrl = await lookupInstanceUrl(sessionId);

  if (!instanceUrl) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    // Proxy the request to the appropriate instance
    const targetUrl = `${instanceUrl}/api/sessions/${sessionId}/asr`;
    debugLog(`[ASR Routing] Proxying ${sessionId} to ${targetUrl}`);
    
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] as string || 'application/octet-stream'
      },
      body: req
    });

    res.status(response.status);
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) return;
        res.write(value);
        return pump();
      };
      await pump();
    }
    res.end();
  } catch (error) {
    debugLog(`[ASR Routing] Error proxying to ${instanceUrl}:`, error);
    res.status(500).json({ error: 'Failed to route ASR request' });
  }
});

// API Routes
app.post('/api/potential-utterances', (req: Request, res: Response) => {
  const { text, timestamp } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  // Register/update session from request data if provided
  let targetSession = null;
  if (req.body.session_id || req.body.cwd || req.body.transcript_path) {
    const sessionId = registerSessionFromRequest(req);
    targetSession = sessionManager.getSession(sessionId);
    
    // Auto-activate the session if it's the only one or if no session is currently active
    const allSessions = sessionManager.getAllSessions();
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession || allSessions.length === 1) {
      sessionManager.setActiveSession(sessionId);
      targetSession = sessionManager.getSession(sessionId);
      debugLog(`[Voice Input] Auto-activated session: ${sessionId}`);
    }
  }

  // Route voice input to the appropriate session's queue
  let targetQueue;
  let routingSession;

  if (targetSession) {
    // Use the session from the request
    targetQueue = targetSession.utteranceQueue;
    routingSession = targetSession;
  } else {
    // Fallback to active session or global queue
    const activeQueue = sessionManager.getActiveUtteranceQueue();
    targetQueue = activeQueue || queue;
    routingSession = sessionManager.getActiveSession();
  }
  
  const parsedTimestamp = timestamp ? new Date(timestamp) : undefined;
  const utterance = targetQueue.add(text, parsedTimestamp);
  
  // Log which session received the voice input
  if (routingSession) {
    debugLog(`[Voice Input] Routed to session: ${routingSession.id} (${routingSession.projectName || 'unknown project'})`);
  } else {
    debugLog(`[Voice Input] Routed to global queue (no active session)`);
  }
  
  // Notify clients about the session update (utterance count changed)
  notifySessionUpdate();
  
  res.json({
    success: true,
    utterance: {
      id: utterance.id,
      text: utterance.text,
      timestamp: utterance.timestamp,
      status: utterance.status,
    },
    sessionId: routingSession?.id || null,
    sessionName: routingSession?.projectName || null,
  });
});

app.get('/api/utterances', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 10;
  
  // Collect utterances from all sources: active session, all sessions, and global queue
  let allUtterances: Utterance[] = [];
  
  // First, get utterances from the active session
  const activeSession = sessionManager.getActiveSession();
  if (activeSession) {
    allUtterances.push(...activeSession.utteranceQueue.utterances);
  }
  
  // Then, get utterances from all other sessions (avoid duplicates)
  const allSessions = sessionManager.getAllSessions();
  allSessions.forEach(session => {
    if (!activeSession || session.id !== activeSession.id) {
      allUtterances.push(...session.utteranceQueue.utterances);
    }
  });
  
  // Finally, add utterances from global queue
  allUtterances.push(...queue.utterances);
  
  // Remove duplicates by id and sort by timestamp
  const uniqueUtterances = Array.from(
    new Map(allUtterances.map(u => [u.id, u])).values()
  ).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
   .slice(0, limit);

  res.json({
    utterances: uniqueUtterances.map(u => ({
      id: u.id,
      text: u.text,
      timestamp: u.timestamp,
      status: u.status,
    })),
  });
});

app.get('/api/utterances/status', (_req: Request, res: Response) => {
  const total = queue.utterances.length;
  const pending = queue.utterances.filter(u => u.status === 'pending').length;
  const delivered = queue.utterances.filter(u => u.status === 'delivered').length;

  res.json({
    total,
    pending,
    delivered,
  });
});

// Shared dequeue logic
function dequeueUtterancesCore() {
  // Check if voice input is active
  if (!voicePreferences.voiceInputActive) {
    return {
      success: false,
      error: 'Voice input is not active. Cannot dequeue utterances when voice input is disabled.'
    };
  }

  // Collect pending utterances from all sources
  let allPendingUtterances: { utterance: Utterance, source: 'global' | 'session', sessionId?: string }[] = [];
  
  // Get from active session first
  const activeSession = sessionManager.getActiveSession();
  if (activeSession) {
    const sessionPending = activeSession.utteranceQueue.utterances.filter(u => u.status === 'pending');
    allPendingUtterances.push(...sessionPending.map(u => ({ utterance: u, source: 'session' as const, sessionId: activeSession.id })));
  }
  
  // Get from all other sessions
  const allSessions = sessionManager.getAllSessions();
  allSessions.forEach(session => {
    if (!activeSession || session.id !== activeSession.id) {
      const sessionPending = session.utteranceQueue.utterances.filter(u => u.status === 'pending');
      allPendingUtterances.push(...sessionPending.map(u => ({ utterance: u, source: 'session' as const, sessionId: session.id })));
    }
  });
  
  // Get from global queue
  const globalPending = queue.utterances.filter(u => u.status === 'pending');
  allPendingUtterances.push(...globalPending.map(u => ({ utterance: u, source: 'global' as const })));
  
  // Sort by timestamp (newest first)
  allPendingUtterances.sort((a, b) => b.utterance.timestamp.getTime() - a.utterance.timestamp.getTime());

  // Mark as delivered in their respective queues
  allPendingUtterances.forEach(({ utterance, source, sessionId }) => {
    if (source === 'global') {
      queue.markDelivered(utterance.id);
    } else if (source === 'session' && sessionId) {
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.utteranceQueue.markDelivered(utterance.id);
      }
    }
  });

  return {
    success: true,
    utterances: allPendingUtterances.map(({ utterance }) => ({
      text: utterance.text,
      timestamp: utterance.timestamp,
    })),
  };
}

// MCP server integration
app.post('/api/dequeue-utterances', (_req: Request, res: Response) => {
  const result = dequeueUtterancesCore();

  if (!result.success && result.error) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
});

// Shared wait for utterance logic
async function waitForUtteranceCore() {
  // Check if voice input is active
  if (!voicePreferences.voiceInputActive) {
    return {
      success: false,
      error: 'Voice input is not active. Cannot wait for utterances when voice input is disabled.'
    };
  }

  const secondsToWait = WAIT_TIMEOUT_SECONDS;
  const maxWaitMs = secondsToWait * 1000;
  const startTime = Date.now();

  debugLog(`[WaitCore] Starting wait_for_utterance (${secondsToWait}s)`);

  // Notify frontend that wait has started
  notifyWaitStatus(true);

  let firstTime = true;

  // Poll for utterances
  while (Date.now() - startTime < maxWaitMs) {
    // Check if voice input is still active
    if (!voicePreferences.voiceInputActive) {
      debugLog('[WaitCore] Voice input deactivated during wait_for_utterance');
      notifyWaitStatus(false); // Notify wait has ended
      return {
        success: true,
        utterances: [],
        message: 'Voice input was deactivated',
        waitTime: Date.now() - startTime,
      };
    }

    // Check for pending utterances from all sources
    let allPendingUtterances: Utterance[] = [];
    
    // Get from active session first
    const activeSession = sessionManager.getActiveSession();
    if (activeSession) {
      allPendingUtterances.push(...activeSession.utteranceQueue.utterances.filter(u => u.status === 'pending'));
    }
    
    // Get from all other sessions
    const allSessions = sessionManager.getAllSessions();
    allSessions.forEach(session => {
      if (!activeSession || session.id !== activeSession.id) {
        allPendingUtterances.push(...session.utteranceQueue.utterances.filter(u => u.status === 'pending'));
      }
    });
    
    // Get from global queue
    allPendingUtterances.push(...queue.utterances.filter(u => u.status === 'pending'));
    
    const pendingUtterances = allPendingUtterances;

    if (pendingUtterances.length > 0) {
      // Found utterances

      // Sort by timestamp (oldest first)
      const sortedUtterances = pendingUtterances
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Mark utterances as delivered in their respective queues
      sortedUtterances.forEach(utterance => {
        // Try to find which queue this utterance belongs to and mark it there
        let marked = false;
        
        // Check active session first
        if (activeSession) {
          const sessionUtterance = activeSession.utteranceQueue.utterances.find(u => u.id === utterance.id);
          if (sessionUtterance) {
            activeSession.utteranceQueue.markDelivered(utterance.id);
            marked = true;
          }
        }
        
        // Check all other sessions
        if (!marked) {
          allSessions.forEach(session => {
            if (!activeSession || session.id !== activeSession.id) {
              const sessionUtterance = session.utteranceQueue.utterances.find(u => u.id === utterance.id);
              if (sessionUtterance) {
                session.utteranceQueue.markDelivered(utterance.id);
                marked = true;
              }
            }
          });
        }
        
        // Check global queue
        if (!marked) {
          const globalUtterance = queue.utterances.find(u => u.id === utterance.id);
          if (globalUtterance) {
            queue.markDelivered(utterance.id);
          }
        }
      });

      notifyWaitStatus(false); // Notify wait has ended
      return {
        success: true,
        utterances: sortedUtterances.map(u => ({
          id: u.id,
          text: u.text,
          timestamp: u.timestamp,
          status: 'delivered', // They are now delivered
        })),
        count: pendingUtterances.length,
        waitTime: Date.now() - startTime,
      };
    }

    if (firstTime) {
      firstTime = false;
      // Play notification sound since we're about to start waiting
      await playNotificationSound();
    }

    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Timeout reached - no utterances found
  notifyWaitStatus(false); // Notify wait has ended
  return {
    success: true,
    utterances: [],
    message: `No utterances found after waiting ${secondsToWait} seconds.`,
    waitTime: maxWaitMs,
  };
}

// Wait for utterance endpoint
app.post('/api/wait-for-utterances', async (_req: Request, res: Response) => {
  const result = await waitForUtteranceCore();

  // If error response, return 400 status
  if (!result.success && result.error) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
});


// API for pre-tool hook to check for pending utterances
app.get('/api/has-pending-utterances', (_req: Request, res: Response) => {
  const pendingCount = queue.utterances.filter(u => u.status === 'pending').length;
  const hasPending = pendingCount > 0;

  res.json({
    hasPending,
    pendingCount
  });
});

// Unified action validation endpoint
app.post('/api/validate-action', (req: Request, res: Response) => {
  const { action } = req.body;
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;

  if (!action || !['tool-use', 'stop'].includes(action)) {
    res.status(400).json({ error: 'Invalid action. Must be "tool-use" or "stop"' });
    return;
  }

  // Only check for pending utterances if voice input is active
  if (voicePreferences.voiceInputActive) {
    const pendingUtterances = queue.utterances.filter(u => u.status === 'pending');
    if (pendingUtterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'dequeue_utterances',
        reason: `${pendingUtterances.length} pending utterance(s) must be dequeued first. Please use dequeue_utterances to process them.`
      });
      return;
    }
  }

  // Check for delivered but unresponded utterances (when voice enabled)
  if (voiceResponsesEnabled) {
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    if (deliveredUtterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'speak',
        reason: `${deliveredUtterances.length} delivered utterance(s) require voice response. Please use the speak tool to respond before proceeding.`
      });
      return;
    }
  }

  // For stop action, check if we should wait (only if voice input is active)
  if (action === 'stop' && voicePreferences.voiceInputActive) {
    if (queue.utterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'wait_for_utterance',
        reason: 'Assistant tried to end its response. Stopping is not allowed without first checking for voice input. Assistant should now use wait_for_utterance to check for voice input'
      });
      return;
    }
  }

  // All checks passed - action is allowed
  res.json({
    allowed: true
  });
});

// Unified hook handler
function handleHookRequest(attemptedAction: 'tool' | 'speak' | 'wait' | 'stop' | 'post-tool'): { decision: 'approve' | 'block', reason?: string } | Promise<{ decision: 'approve' | 'block', reason?: string }> {
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;
  const voiceInputActive = voicePreferences.voiceInputActive;

  // 1. Check for pending utterances (different behavior based on action and settings)
  if (voiceInputActive) {
    const pendingUtterances = queue.utterances.filter(u => u.status === 'pending');
    if (pendingUtterances.length > 0) {
      if (AUTO_DELIVER_VOICE_INPUT) {
        // Auto mode: check if we should auto-deliver
        if (attemptedAction === 'tool' && !AUTO_DELIVER_VOICE_INPUT_BEFORE_TOOLS) {
          // Skip auto-delivery for tools when disabled
        } else {
          // Auto-dequeue for non-tool actions, or for tools when enabled
          const dequeueResult = dequeueUtterancesCore();

          if (dequeueResult.success && dequeueResult.utterances && dequeueResult.utterances.length > 0) {
            // Reverse to show oldest first
            const reversedUtterances = dequeueResult.utterances.reverse();

            return {
              decision: 'block',
              reason: formatVoiceUtterances(reversedUtterances)
            };
          }
        }
      } else {
        // Manual mode: always block and tell assistant to use dequeue_utterances tool
        return {
          decision: 'block',
          reason: `${pendingUtterances.length} pending utterance(s) available. Use the dequeue_utterances tool to retrieve them.`
        };
      }
    }
  }

  // 2. Check for delivered utterances (when voice enabled)
  if (voiceResponsesEnabled) {
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    if (deliveredUtterances.length > 0) {
      // Only allow speak to proceed
      if (attemptedAction === 'speak') {
        return { decision: 'approve' };
      }
      return {
        decision: 'block',
        reason: `${deliveredUtterances.length} delivered utterance(s) require voice response. Please use the speak tool to respond before proceeding.`
      };
    }
  }

  // 3. Handle tool and post-tool actions
  if (attemptedAction === 'tool' || attemptedAction === 'post-tool') {
    lastToolUseTimestamp = new Date();
    return { decision: 'approve' };
  }

  // 4. Handle wait for utterance
  if (attemptedAction === 'wait') {
    if (voiceResponsesEnabled && lastToolUseTimestamp &&
      (!lastSpeakTimestamp || lastSpeakTimestamp < lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before waiting for utterances.'
      };
    }
    return { decision: 'approve' };
  }

  // 5. Handle speak
  if (attemptedAction === 'speak') {
    return { decision: 'approve' };
  }

  // 6. Handle stop
  if (attemptedAction === 'stop') {
    // Check if must speak after tool use
    if (voiceResponsesEnabled && lastToolUseTimestamp &&
      (!lastSpeakTimestamp || lastSpeakTimestamp < lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before proceeding.'
      };
    }

    // Check if should wait for utterances (only if voice input is active)
    if (voiceInputActive) {
      if (AUTO_DELIVER_VOICE_INPUT) {
        // Auto-wait for utterances
        return (async () => {
          try {
            debugLog(`[Stop Hook] Auto-calling wait_for_utterance...`);
            const data = await waitForUtteranceCore();
            debugLog(`[Stop Hook] wait_for_utterance response: ${JSON.stringify(data)}`);

            // If error (voice input not active), treat as no utterances found
            if (!data.success && data.error) {
              return {
                decision: 'approve' as const,
                reason: data.error
              };
            }

            // If utterances were found, block and return them
            if (data.utterances && data.utterances.length > 0) {
              return {
                decision: 'block' as const,
                reason: formatVoiceUtterances(data.utterances)
              };
            }

            // If no utterances found (including when voice was deactivated), approve stop
            return {
              decision: 'approve' as const,
              reason: data.message || 'No utterances found during wait'
            };
          } catch (error) {
            debugLog(`[Stop Hook] Error calling wait_for_utterance: ${error}`);
            // In auto-deliver mode, fail open on errors
            return {
              decision: 'approve' as const,
              reason: 'Auto-wait encountered an error, proceeding'
            };
          }
        })();
      } else {
        // Manual mode: block and tell assistant to use wait_for_utterance tool
        return {
          decision: 'block',
          reason: 'Assistant tried to end its response, but voice input is active. Stopping is not allowed without first checking for voice input. Assistant should now use wait_for_utterance to check for voice input'
        };
      }
    }

    return {
      decision: 'approve',
      reason: 'No utterances since last timeout'
    };
  }

  // Default to approve (shouldn't reach here)
  return { decision: 'approve' };
}

// Helper function to register session from request data
function registerSessionFromRequest(req: Request): string {
  const sessionData: SessionData = {
    sessionId: req.body?.session_id,
    workingDirectory: req.body?.cwd || process.cwd(), // Use current working directory as fallback
    transcriptPath: req.body?.transcript_path,
    userAgent: req.headers['user-agent'] as string,
    clientVersion: (req.headers['x-claude-version'] || req.headers['x-client-version']) as string,
  };
  
  const sessionId = sessionManager.registerSession(sessionData);
  debugLog(`[Session] Registered session from request: ${sessionId}`);
  return sessionId;
}

// Helper function to get the appropriate utterance queue based on session context
function getContextualUtteranceQueue(req?: Request): UtteranceQueue {
  if (req) {
    const sessionId = registerSessionFromRequest(req);
    const sessionQueue = sessionManager.getUtteranceQueue(sessionId);
    if (sessionQueue) {
      return sessionQueue;
    }
  }
  
  // Fall back to active session queue
  const activeQueue = sessionManager.getActiveUtteranceQueue();
  if (activeQueue) {
    return activeQueue;
  }
  
  // Final fallback to global queue for backward compatibility
  return queue;
}

// Dedicated hook endpoints that return in Claude's expected format
app.post('/api/hooks/pre-tool', (req: Request, res: Response) => {
  const sessionId = registerSessionFromRequest(req);
  registerSession(sessionId, INSTANCE_URL);
  const result = handleHookRequest('tool');
  res.json(result);
});

app.post('/api/hooks/stop', async (req: Request, res: Response) => {
  const sessionId = registerSessionFromRequest(req);
  registerSession(sessionId, INSTANCE_URL);
  const result = await handleHookRequest('stop');
  res.json(result);
});

// Pre-speak hook endpoint
app.post('/api/hooks/pre-speak', async (req: Request, res: Response) => {
  const sessionId = registerSessionFromRequest(req);
  
  // Register session mapping for ASR routing
  registerSession(sessionId, INSTANCE_URL);
  
  // Generate speak event
  const text = req.body?.text ?? req.body?.message ?? '';
  const event = {
    sessionId,
    instanceUrl: INSTANCE_URL,
    text,
    meta: { tool: 'speak', bodyKeys: Object.keys(req.body || {}) }
  };

  try {
    if (INSTANCE_ROLE === 'primary') {
      // Primary instance: broadcast directly
      broadcastAll({ type: 'speak', at: Date.now(), ...event });
    } else {
      // Secondary instance: forward to primary
      await fetch(`${PRIMARY_URL}/feed/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event)
      }).catch((error) => {
        debugLog(`[Event Forward] Failed to forward to primary:`, error);
      });
    }
  } catch (e) {
    debugLog('[Pre-speak] Event processing error:', (e as Error).message);
  }

  // Continue with normal hook processing
  const result = handleHookRequest('speak');
  res.json(result);
});

// Pre-wait hook endpoint
app.post('/api/hooks/pre-wait', (req: Request, res: Response) => {
  const sessionId = registerSessionFromRequest(req);
  registerSession(sessionId, INSTANCE_URL);
  const result = handleHookRequest('wait');
  res.json(result);
});

// Post-tool hook endpoint
app.post('/api/hooks/post-tool', (req: Request, res: Response) => {
  const sessionId = registerSessionFromRequest(req);
  registerSession(sessionId, INSTANCE_URL);
  // Use the unified handler with 'post-tool' action
  const result = handleHookRequest('post-tool');
  res.json(result);
});

// API to clear all utterances
app.delete('/api/utterances', (_req: Request, res: Response) => {
  const clearedCount = queue.utterances.length;
  queue.clear();

  res.json({
    success: true,
    message: `Cleared ${clearedCount} utterances`,
    clearedCount
  });
});

// Session management API endpoints
app.get('/api/sessions', (_req: Request, res: Response) => {
  const sessions = sessionManager.getAllSessions();
  const activeSessionId = sessionManager.getActiveSession()?.id || null;
  
  res.json({
    sessions: sessions.map(session => ({
      id: session.id,
      projectPath: session.projectPath,
      projectName: session.projectName,
      isActive: session.isActive,
      lastActivity: session.lastActivity,
      pendingUtterances: session.utteranceQueue.utterances.filter(u => u.status === 'pending').length,
      totalUtterances: session.utteranceQueue.utterances.length,
      metadata: session.metadata
    })),
    activeSessionId,
    summary: sessionManager.getSessionSummary()
  });
});

app.post('/api/sessions/:sessionId/activate', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const success = sessionManager.setActiveSession(sessionId);
  
  if (success) {
    res.json({
      success: true,
      activeSessionId: sessionId,
      message: `Activated session ${sessionId}`
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Session not found or inactive'
    });
  }
});

app.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  
  if (!session) {
    res.status(404).json({
      success: false,
      error: 'Session not found'
    });
    return;
  }
  
  sessionManager.removeSession(sessionId);
  res.json({
    success: true,
    message: `Removed session ${sessionId}`
  });
});

app.post('/api/sessions/:sessionId/utterances/clear', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  
  if (!session) {
    res.status(404).json({
      success: false,
      error: 'Session not found'
    });
    return;
  }
  
  const clearedCount = session.utteranceQueue.utterances.length;
  session.utteranceQueue.clear();
  
  res.json({
    success: true,
    message: `Cleared ${clearedCount} utterances from session ${sessionId}`,
    clearedCount
  });
});

// Server-Sent Events for TTS notifications
const ttsClients = new Set<Response>();

app.get('/api/tts-events', (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Add client to set
  ttsClients.add(res);

  // Remove client on disconnect
  res.on('close', () => {
    ttsClients.delete(res);
    
    // If no clients remain, disable voice features
    if (ttsClients.size === 0) {
      debugLog('[SSE] Last browser disconnected, disabling voice features');
      if (voicePreferences.voiceInputActive || voicePreferences.voiceResponsesEnabled) {
        debugLog(`[SSE] Voice features disabled - Input: ${voicePreferences.voiceInputActive} -> false, Responses: ${voicePreferences.voiceResponsesEnabled} -> false`);
        voicePreferences.voiceInputActive = false;
        voicePreferences.voiceResponsesEnabled = false;
      }
    } else {
      debugLog(`[SSE] Browser disconnected, ${ttsClients.size} client(s) remaining`);
    }
  });
});

// Helper function to notify all connected TTS clients
function notifyTTSClients(text: string, sessionId?: string, sessionName?: string) {
  const message = JSON.stringify({ 
    type: 'speak', 
    text,
    sessionId: sessionId || null,
    sessionName: sessionName || null
  });
  ttsClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Helper function to notify all connected clients about wait status
function notifyWaitStatus(isWaiting: boolean) {
  const message = JSON.stringify({ type: 'waitStatus', isWaiting });
  ttsClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Helper function to notify all connected clients about session changes
function notifySessionUpdate() {
  const sessions = sessionManager.getAllSessions();
  const activeSessionId = sessionManager.getActiveSession()?.id || null;
  
  const message = JSON.stringify({
    type: 'sessionUpdate',
    sessions: sessions.map(session => ({
      id: session.id,
      projectPath: session.projectPath,
      projectName: session.projectName,
      isActive: session.isActive,
      lastActivity: session.lastActivity,
      pendingUtterances: session.utteranceQueue.utterances.filter(u => u.status === 'pending').length,
      totalUtterances: session.utteranceQueue.utterances.length,
      metadata: session.metadata
    })),
    activeSessionId,
    summary: sessionManager.getSessionSummary()
  });
  
  ttsClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Helper function to format voice utterances for display
function formatVoiceUtterances(utterances: any[]): string {
  const utteranceTexts = utterances
    .map(u => `"${u.text}"`)
    .join('\n');

  return `Assistant received voice input from the user (${utterances.length} utterance${utterances.length !== 1 ? 's' : ''}):\n\n${utteranceTexts}${getVoiceResponseReminder()}`;
}

// API for voice preferences
app.post('/api/voice-preferences', (req: Request, res: Response) => {
  const { voiceResponsesEnabled } = req.body;

  // Update preferences
  voicePreferences.voiceResponsesEnabled = !!voiceResponsesEnabled;

  debugLog(`[Preferences] Updated: voiceResponses=${voicePreferences.voiceResponsesEnabled}`);

  res.json({
    success: true,
    preferences: voicePreferences
  });
});

// API for voice input state
app.post('/api/voice-input-state', (req: Request, res: Response) => {
  const { active } = req.body;

  // Update voice input state
  voicePreferences.voiceInputActive = !!active;

  debugLog(`[Voice Input] ${voicePreferences.voiceInputActive ? 'Started' : 'Stopped'} listening`);

  res.json({
    success: true,
    voiceInputActive: voicePreferences.voiceInputActive
  });
});

// API for text-to-speech
app.post('/api/speak', async (req: Request, res: Response) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  // Check if voice responses are enabled
  if (!voicePreferences.voiceResponsesEnabled) {
    debugLog(`[Speak] Voice responses disabled, returning error`);
    res.status(400).json({
      error: 'Voice responses are disabled',
      message: 'Cannot speak when voice responses are disabled'
    });
    return;
  }

  try {
    // Try to determine which session is speaking by looking at delivered utterances
    let speakingSessionId: string | undefined;
    let speakingSessionName: string | undefined;
    
    // First, check the active session for delivered utterances
    const activeSession = sessionManager.getActiveSession();
    if (activeSession) {
      const activeDeliveredUtterances = activeSession.utteranceQueue.utterances.filter(u => u.status === 'delivered');
      if (activeDeliveredUtterances.length > 0) {
        speakingSessionId = activeSession.id;
        speakingSessionName = activeSession.projectName;
      }
    }
    
    // If not found in active session, check all sessions
    if (!speakingSessionId) {
      const allSessions = sessionManager.getAllSessions();
      for (const session of allSessions) {
        const deliveredUtterances = session.utteranceQueue.utterances.filter(u => u.status === 'delivered');
        if (deliveredUtterances.length > 0) {
          speakingSessionId = session.id;
          speakingSessionName = session.projectName;
          break;
        }
      }
    }
    
    // Fall back to global queue if no session has delivered utterances
    if (!speakingSessionId) {
      const globalDeliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
      if (globalDeliveredUtterances.length > 0) {
        speakingSessionId = 'global';
        speakingSessionName = 'Global Queue';
      }
    }

    // Notify browser clients with session information
    notifyTTSClients(text, speakingSessionId, speakingSessionName);
    debugLog(`[Speak] Sent text to browser for TTS: "${text}" (Session: ${speakingSessionName || 'unknown'})`);

    // Note: The browser will decide whether to use system voice or browser voice

    // Mark all delivered utterances as responded
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    deliveredUtterances.forEach(u => {
      u.status = 'responded';
      debugLog(`[Queue] marked as responded: "${u.text}"	[id: ${u.id}]`);
    });

    lastSpeakTimestamp = new Date();

    res.json({
      success: true,
      message: 'Text spoken successfully',
      respondedCount: deliveredUtterances.length,
      sessionId: speakingSessionId,
      sessionName: speakingSessionName
    });
  } catch (error) {
    debugLog(`[Speak] Failed to speak text: ${error}`);
    res.status(500).json({
      error: 'Failed to speak text',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// API for system text-to-speech (always uses Mac say command)
app.post('/api/speak-system', async (req: Request, res: Response) => {
  const { text, rate = 150 } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  try {
    // Execute text-to-speech using macOS say command
    // Note: Mac say command doesn't support volume control
    await execAsync(`say -r ${rate} "${text.replace(/"/g, '\\"')}"`);
    debugLog(`[Speak System] Spoke text using macOS say: "${text}" (rate: ${rate})`);

    res.json({
      success: true,
      message: 'Text spoken successfully via system voice'
    });
  } catch (error) {
    debugLog(`[Speak System] Failed to speak text: ${error}`);
    res.status(500).json({
      error: 'Failed to speak text via system voice',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Only serve index.html if UI is enabled
if (!DISABLE_UI) {
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
}

// Start HTTP server with WebSocket support
server.listen(HTTP_PORT, async () => {
  const logFn = IS_MCP_MANAGED ? console.error : console.log;
  
  logFn(`[${INSTANCE_ROLE.toUpperCase()}] Server listening on http://localhost:${HTTP_PORT}`);
  logFn(`[Mode] Running in ${IS_MCP_MANAGED ? 'MCP-managed' : 'standalone'} mode`);
  logFn(`[Role] ${INSTANCE_ROLE} instance - UI ${DISABLE_UI ? 'disabled' : 'enabled'}`);
  
  if (INSTANCE_ROLE === 'secondary') {
    logFn(`[Primary] Connected to primary at ${PRIMARY_URL}`);
  } else {
    logFn(`[WebSocket] ${wss ? 'enabled' : 'disabled'} on /ws`);
  }
  
  logFn(`[Auto-deliver] Voice input auto-delivery is ${AUTO_DELIVER_VOICE_INPUT ? 'enabled (tools hidden)' : 'disabled (tools shown)'}`);
  logFn(`[Pre-tool Hook] Auto-deliver voice input before tools is ${AUTO_DELIVER_VOICE_INPUT_BEFORE_TOOLS ? 'enabled' : 'disabled'}`);

  // Auto-open browser only for primary instances with UI enabled
  const autoOpenBrowser = process.env.MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER !== 'false'; // Default to true
  if (IS_MCP_MANAGED && autoOpenBrowser && INSTANCE_ROLE === 'primary' && !DISABLE_UI) {
    setTimeout(async () => {
      if (ttsClients.size === 0) {
        debugLog('[Browser] No frontend connected, opening browser...');
        try {
          const open = (await import('open')).default;
          await open(`http://localhost:${HTTP_PORT}`);
        } catch (error) {
          debugLog('[Browser] Failed to open browser:', error);
        }
      } else {
        debugLog(`[Browser] Frontend already connected (${ttsClients.size} client(s))`)
      }
    }, 3000);
  }
});

// Helper function to get voice response reminder
function getVoiceResponseReminder(): string {
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;
  return voiceResponsesEnabled
    ? '\n\nThe user has enabled voice responses, so use the \'speak\' tool to respond to the user\'s voice input before proceeding.'
    : '';
}

// MCP Server Setup (only if MCP-managed)
if (IS_MCP_MANAGED) {
  // Use stderr in MCP mode to avoid interfering with protocol
  console.error('[MCP] Initializing MCP server...');

  const mcpServer = new Server(
    {
      name: 'voice-hooks',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool handlers
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];

    // Only show dequeue_utterances and wait_for_utterance if auto-deliver is disabled
    if (!AUTO_DELIVER_VOICE_INPUT) {
      tools.push(
        {
          name: 'dequeue_utterances',
          description: 'Dequeue pending utterances and mark them as delivered',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'wait_for_utterance',
          description: 'Wait for an utterance to be available or until timeout',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        }
      );
    }

    // Always show the speak tool
    tools.push({
      name: 'speak',
      description: 'Speak text using text-to-speech and mark delivered utterances as responded',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to speak',
          },
        },
        required: ['text'],
      },
    });

    return { tools };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'dequeue_utterances') {
        const response = await fetch(`http://localhost:${HTTP_PORT}/api/dequeue-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        const data = await response.json() as any;

        // Check if the request was successful
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${data.error || 'Failed to dequeue utterances'}`,
              },
            ],
          };
        }

        if (data.utterances.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No recent utterances found.',
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Dequeued ${data.utterances.length} utterance(s):\n\n${data.utterances.reverse().map((u: any) => `"${u.text}"\t[time: ${new Date(u.timestamp).toISOString()}]`).join('\n')
                }${getVoiceResponseReminder()}`,
            },
          ],
        };
      }

      if (name === 'wait_for_utterance') {
        debugLog(`[MCP] Calling wait_for_utterance`);

        const response = await fetch(`http://localhost:${HTTP_PORT}/api/wait-for-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        const data = await response.json() as any;

        // Check if the request was successful
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${data.error || 'Failed to wait for utterances'}`,
              },
            ],
          };
        }

        if (data.utterances && data.utterances.length > 0) {
          const utteranceTexts = data.utterances
            .map((u: any) => `[${u.timestamp}] "${u.text}"`)
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${data.count} utterance(s):\n\n${utteranceTexts}${getVoiceResponseReminder()}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: data.message || `No utterances found. Timed out.`,
              },
            ],
          };
        }
      }

      if (name === 'speak') {
        const text = args?.text as string;

        if (!text || !text.trim()) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: Text is required for speak tool',
              },
            ],
            isError: true,
          };
        }

        const response = await fetch(`http://localhost:${HTTP_PORT}/api/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });

        const data = await response.json() as any;

        if (response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: '',  // Return empty string for success
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Error speaking text: ${data.error || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
  // Use stderr in MCP mode to avoid interfering with protocol
  console.error('[MCP] Server connected via stdio');
} else {
  // Only log in standalone mode
  if (!IS_MCP_MANAGED) {
    console.log('[MCP] Skipping MCP server initialization (not in MCP-managed mode)');
  }
}