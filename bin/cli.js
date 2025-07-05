#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main entry point for npx mcp-voice-hooks
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (command === 'install-hooks') {
      console.log('🔧 Installing MCP Voice Hooks...');
      
      // Step 1: Ensure user directory exists and install/update hooks
      await ensureUserDirectorySetup();
      
      // Step 2: Configure Claude Code settings automatically
      await configureClaudeCodeSettings();
      
      console.log('\n✅ Installation complete!');
      console.log('📝 To start the server, run: npx mcp-voice-hooks');
    } else {
      // Default behavior: ensure hooks are installed/updated, then run the MCP server
      console.log('🎤 MCP Voice Hooks - Starting server...');
      
      // Auto-install/update hooks on every startup
      await ensureHooksInstalled();
      
      console.log('');
      await runMCPServer();
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Ensure ~/.mcp-voice-hooks/hooks/ directory exists and contains latest hook files
async function ensureUserDirectorySetup() {
  const userDir = path.join(os.homedir(), '.mcp-voice-hooks');
  const hooksDir = path.join(userDir, 'hooks');
  
  console.log('📁 Setting up user directory:', userDir);
  
  // Create directories if they don't exist
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
    console.log('✅ Created user directory');
  }
  
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
    console.log('✅ Created hooks directory');
  }
  
  // Copy/update hook files from the package's .claude/hooks/ to user directory
  const packageHooksDir = path.join(__dirname, '..', '.claude', 'hooks');
  
  if (fs.existsSync(packageHooksDir)) {
    const hookFiles = fs.readdirSync(packageHooksDir).filter(file => file.endsWith('.sh'));
    
    for (const hookFile of hookFiles) {
      const sourcePath = path.join(packageHooksDir, hookFile);
      const destPath = path.join(hooksDir, hookFile);
      
      // Copy hook file
      fs.copyFileSync(sourcePath, destPath);
      console.log(`✅ Updated hook: ${hookFile}`);
    }
  } else {
    console.log('⚠️  Package hooks directory not found, skipping hook installation');
  }
}

// Automatically configure Claude Code settings
async function configureClaudeCodeSettings() {
  const claudeDir = path.join(process.cwd(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  
  console.log('⚙️  Configuring project Claude Code settings...');
  
  // Create .claude directory if it doesn't exist
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    console.log('✅ Created project .claude directory');
  }
  
  // Read existing settings or create new
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const settingsContent = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(settingsContent);
      console.log('📖 Read existing settings');
    } catch (error) {
      console.log('⚠️  Error reading existing settings, creating new');
      settings = {};
    }
  }
  
  // Add hook configuration
  const hookConfig = {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "sh ~/.mcp-voice-hooks/hooks/stop-hook.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "^(?!mcp__voice-hooks__).*",
        "hooks": [
          {
            "type": "command",
            "command": "sh ~/.mcp-voice-hooks/hooks/pre-tool-hook.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^mcp__voice-hooks__",
        "hooks": [
          {
            "type": "command",
            "command": "sh ~/.mcp-voice-hooks/hooks/post-tool-voice-hook.sh"
          }
        ]
      }
    ]
  };
  
  // Update settings
  settings.hooks = hookConfig;
  
  // Write settings back
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✅ Updated project Claude Code settings');
}

// Silent hook installation check - runs on every startup
async function ensureHooksInstalled() {
  const userDir = path.join(os.homedir(), '.mcp-voice-hooks');
  const hooksDir = path.join(userDir, 'hooks');
  const packageHooksDir = path.join(__dirname, '..', '.claude', 'hooks');
  
  try {
    // Only create directories if they don't exist
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
      console.log('🔧 Installing hooks for first time...');
    }
    
    // Check if hooks need updating
    let needsUpdate = false;
    if (fs.existsSync(packageHooksDir)) {
      const hookFiles = fs.readdirSync(packageHooksDir).filter(file => file.endsWith('.sh'));
      
      for (const hookFile of hookFiles) {
        const sourcePath = path.join(packageHooksDir, hookFile);
        const destPath = path.join(hooksDir, hookFile);
        
        // Check if hook doesn't exist or is different
        if (!fs.existsSync(destPath)) {
          needsUpdate = true;
          break;
        }
        
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        const destContent = fs.readFileSync(destPath, 'utf8');
        
        if (sourceContent !== destContent) {
          needsUpdate = true;
          break;
        }
      }
    }
    
    if (needsUpdate) {
      console.log('🔄 Updating hooks to latest version...');
      await ensureUserDirectorySetup();
      // Don't reconfigure Claude settings on auto-update
      console.log('✅ Hooks updated');
    }
  } catch (error) {
    // Silently continue if hooks can't be updated
    console.warn('⚠️  Could not auto-update hooks:', error.message);
  }
}

// Run the MCP server
async function runMCPServer() {
  const serverPath = path.join(__dirname, '..', 'dist', 'unified-server.js');
  
  // Run the compiled JavaScript server
  const child = spawn('node', [serverPath, '--mcp-managed'], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  
  child.on('error', (error) => {
    console.error('❌ Failed to start MCP server:', error.message);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    console.log(`🔄 MCP server exited with code ${code}`);
    process.exit(code);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    child.kill('SIGINT');
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    child.kill('SIGTERM');
  });
}

// Run the main function
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});