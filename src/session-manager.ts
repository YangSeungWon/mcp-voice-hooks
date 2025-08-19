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

export interface SessionData {
  sessionId?: string;
  projectPath?: string;
  workingDirectory?: string;
  userAgent?: string;
  clientVersion?: string;
  transcriptPath?: string;
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
   * Register or update a session based on session data
   */
  registerSession(sessionData: SessionData): string {
    debugLog(`[SessionManager] Registering session with data: ${JSON.stringify(sessionData)}`);
    
    const sessionId = this.generateSessionId(sessionData);
    const projectPath = this.extractProjectPath(sessionData);
    const projectName = this.extractProjectName(projectPath);
    
    debugLog(`[SessionManager] Generated session ID: ${sessionId}, projectPath: ${projectPath}, projectName: ${projectName}`);

    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Create new session
      session = {
        id: sessionId,
        projectPath,
        projectName,
        lastActivity: new Date(),
        isActive: true,
        utteranceQueue: new InMemoryUtteranceQueue(),
        metadata: {
          workingDirectory: sessionData.workingDirectory,
          userAgent: sessionData.userAgent,
          clientVersion: sessionData.clientVersion,
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
      if (projectPath) {
        session.projectPath = projectPath;
        session.projectName = projectName;
      }
      if (sessionData.workingDirectory) session.metadata.workingDirectory = sessionData.workingDirectory;
      if (sessionData.userAgent) session.metadata.userAgent = sessionData.userAgent;
      if (sessionData.clientVersion) session.metadata.clientVersion = sessionData.clientVersion;
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
   * Generate session ID from session data
   */
  private generateSessionId(sessionData: SessionData): string {
    // Use provided session ID if available
    if (sessionData.sessionId) {
      return sessionData.sessionId;
    }

    // Fall back to generating ID based on available information
    const projectPath = this.extractProjectPath(sessionData);
    const workingDir = sessionData.workingDirectory;
    const userAgent = sessionData.userAgent;
    
    // Create a unique session key with timestamp if no identifying info available
    let sessionKey: string;
    if (!projectPath && !workingDir) {
      // If both projectPath and workingDir are missing, add timestamp to ensure uniqueness
      const timestamp = Date.now();
      sessionKey = `session_${timestamp}:${userAgent || 'unknown'}`;
    } else {
      // Use available information to create deterministic session ID
      sessionKey = `${projectPath || 'no-path'}:${workingDir || 'no-workdir'}:${userAgent || 'no-useragent'}`;
    }
    
    // Use a simple hash to create consistent session IDs
    return this.simpleHash(sessionKey);
  }

  /**
   * Extract project path from session data
   */
  private extractProjectPath(sessionData: SessionData): string | undefined {
    // Use explicit project path if provided
    if (sessionData.projectPath) {
      return sessionData.projectPath;
    }
    
    // Extract from transcript path if available
    if (sessionData.transcriptPath) {
      const transcriptDir = sessionData.transcriptPath.replace(/\/\.claude\/.*$/, '');
      if (transcriptDir !== sessionData.transcriptPath) {
        return transcriptDir;
      }
    }
    
    // Fall back to working directory
    return sessionData.workingDirectory;
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