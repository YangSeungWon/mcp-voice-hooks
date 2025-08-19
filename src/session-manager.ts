import { randomUUID } from 'crypto';
import { InMemoryUtteranceQueue } from './utterance-queue.js';
import { debugLog } from './debug.js';

export interface SessionInfo {
  id: string;
  projectPath?: string;
  projectName?: string;
  lastActivity: Date;
  isActive: boolean;
  utteranceQueue: InMemoryUtteranceQueue;
  metadata: {
    workingDirectory?: string;
    userAgent?: string;
    clientVersion?: string;
  };
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private activeSessionId: string | null = null;
  private changeCallback?: () => void;

  constructor() {
    // Clean up inactive sessions every 5 minutes
    setInterval(() => this.cleanupInactiveSessions(), 5 * 60 * 1000);
  }

  /**
   * Set callback function to be called when sessions change
   */
  setChangeCallback(callback: () => void): void {
    this.changeCallback = callback;
  }

  /**
   * Notify about session changes
   */
  private notifyChange(): void {
    if (this.changeCallback) {
      this.changeCallback();
    }
  }

  /**
   * Register or update a session based on hook request headers
   */
  registerSession(headers: Record<string, string | string[] | undefined>): string {
    // Extract session information from headers
    const sessionId = this.extractSessionId(headers);
    const projectPath = this.extractProjectPath(headers);
    const workingDirectory = this.extractWorkingDirectory(headers);
    const userAgent = this.extractUserAgent(headers);
    const clientVersion = this.extractClientVersion(headers);

    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Create new session
      session = {
        id: sessionId,
        projectPath,
        projectName: this.extractProjectName(projectPath),
        lastActivity: new Date(),
        isActive: true,
        utteranceQueue: new InMemoryUtteranceQueue(),
        metadata: {
          workingDirectory,
          userAgent,
          clientVersion,
        },
      };
      this.sessions.set(sessionId, session);
      
      // If this is the first session, make it active
      if (!this.activeSessionId) {
        this.activeSessionId = sessionId;
      }
      
      debugLog(`[SessionManager] Registered new session: ${sessionId} (${session.projectName || 'unknown project'})`);
      this.notifyChange();
    } else {
      // Update existing session
      session.lastActivity = new Date();
      session.isActive = true;
      if (projectPath) session.projectPath = projectPath;
      if (projectPath) session.projectName = this.extractProjectName(projectPath);
      session.metadata.workingDirectory = workingDirectory;
      session.metadata.userAgent = userAgent;
      session.metadata.clientVersion = clientVersion;
    }

    return sessionId;
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the active session
   */
  getActiveSession(): SessionInfo | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Set the active session
   */
  setActiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) {
      return false;
    }
    
    this.activeSessionId = sessionId;
    debugLog(`[SessionManager] Active session changed to: ${sessionId} (${session.projectName || 'unknown project'})`);
    this.notifyChange();
    return true;
  }

  /**
   * Get the utterance queue for the active session
   */
  getActiveUtteranceQueue(): InMemoryUtteranceQueue | undefined {
    const activeSession = this.getActiveSession();
    return activeSession?.utteranceQueue;
  }

  /**
   * Get utterance queue for a specific session
   */
  getUtteranceQueue(sessionId: string): InMemoryUtteranceQueue | undefined {
    const session = this.sessions.get(sessionId);
    return session?.utteranceQueue;
  }

  /**
   * Mark session as inactive
   */
  markSessionInactive(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      session.lastActivity = new Date();
      
      // If this was the active session, switch to another active session
      if (this.activeSessionId === sessionId) {
        const activeSessions = Array.from(this.sessions.values())
          .filter(s => s.isActive && s.id !== sessionId)
          .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
        
        this.activeSessionId = activeSessions.length > 0 ? activeSessions[0].id : null;
        debugLog(`[SessionManager] Session ${sessionId} marked inactive. Active session now: ${this.activeSessionId || 'none'}`);
      }
      this.notifyChange();
    }
  }

  /**
   * Remove a session completely
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      
      if (this.activeSessionId === sessionId) {
        // Find another active session
        const activeSessions = Array.from(this.sessions.values())
          .filter(s => s.isActive)
          .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
        
        this.activeSessionId = activeSessions.length > 0 ? activeSessions[0].id : null;
      }
      
      debugLog(`[SessionManager] Session ${sessionId} removed. Active session now: ${this.activeSessionId || 'none'}`);
      this.notifyChange();
    }
  }

  /**
   * Clean up sessions that haven't been active for more than 30 minutes
   */
  private cleanupInactiveSessions(): void {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const sessionsToRemove: string[] = [];
    
    for (const [sessionId, session] of this.sessions) {
      if (!session.isActive && session.lastActivity < thirtyMinutesAgo) {
        sessionsToRemove.push(sessionId);
      }
    }
    
    for (const sessionId of sessionsToRemove) {
      this.removeSession(sessionId);
      debugLog(`[SessionManager] Cleaned up inactive session: ${sessionId}`);
    }
    
    // Only notify once at the end if any sessions were removed
    if (sessionsToRemove.length > 0) {
      this.notifyChange();
    }
  }

  /**
   * Extract session ID from headers (using project path + user agent as fallback)
   */
  private extractSessionId(headers: Record<string, string | string[] | undefined>): string {
    // Try to get session ID from custom header first
    const customSessionId = this.getHeaderValue(headers, 'x-claude-session-id');
    if (customSessionId) return customSessionId;

    // Fall back to generating ID based on project path and user agent
    const projectPath = this.extractProjectPath(headers);
    const userAgent = this.extractUserAgent(headers);
    const workingDir = this.extractWorkingDirectory(headers);
    
    // Create a deterministic session ID based on available information
    const sessionKey = `${projectPath || 'unknown'}:${workingDir || 'unknown'}:${userAgent || 'unknown'}`;
    
    // Use a simple hash to create consistent session IDs
    return this.simpleHash(sessionKey);
  }

  /**
   * Extract project path from headers
   */
  private extractProjectPath(headers: Record<string, string | string[] | undefined>): string | undefined {
    return this.getHeaderValue(headers, 'x-claude-project-path') || 
           this.getHeaderValue(headers, 'x-working-directory');
  }

  /**
   * Extract working directory from headers
   */
  private extractWorkingDirectory(headers: Record<string, string | string[] | undefined>): string | undefined {
    return this.getHeaderValue(headers, 'x-working-directory') ||
           this.getHeaderValue(headers, 'x-claude-working-directory');
  }

  /**
   * Extract user agent from headers
   */
  private extractUserAgent(headers: Record<string, string | string[] | undefined>): string | undefined {
    return this.getHeaderValue(headers, 'user-agent');
  }

  /**
   * Extract Claude Code client version from headers
   */
  private extractClientVersion(headers: Record<string, string | string[] | undefined>): string | undefined {
    return this.getHeaderValue(headers, 'x-claude-version') ||
           this.getHeaderValue(headers, 'x-client-version');
  }

  /**
   * Extract project name from project path
   */
  private extractProjectName(projectPath?: string): string | undefined {
    if (!projectPath) return undefined;
    
    // Extract the last directory name from the path
    const parts = projectPath.replace(/\\/g, '/').split('/').filter(p => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : undefined;
  }

  /**
   * Get header value as string
   */
  private getHeaderValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
    const value = headers[key.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  /**
   * Simple hash function for creating consistent session IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `session_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Get session summary for debugging
   */
  getSessionSummary(): string {
    const sessions = this.getAllSessions();
    const activeSessions = sessions.filter(s => s.isActive);
    
    return `Sessions: ${sessions.length} total, ${activeSessions.length} active. Active session: ${this.activeSessionId || 'none'}`;
  }
}