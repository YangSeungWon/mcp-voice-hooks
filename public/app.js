class VoiceHooksClient {
    constructor() {
        this.baseUrl = window.location.origin;
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';
        this.refreshBtn = document.getElementById('refreshBtn');
        this.clearAllBtn = document.getElementById('clearAllBtn');
        this.chatContainer = document.getElementById('chatContainer');
        this.typingIndicator = document.getElementById('typingIndicator');
        this.messages = []; // Store all chat messages
        this.infoMessage = document.getElementById('infoMessage');
        
        
        // Dashboard elements
        this.systemStatsFooter = document.getElementById('systemStatsFooter');
        this.voiceSection = document.getElementById('voiceSection');
        this.voiceSettingsBtn = document.getElementById('voiceSettingsBtn');
        this.hideVoiceBtn = document.getElementById('hideVoiceBtn');
        this.refreshActivityBtn = document.getElementById('refreshActivityBtn');

        // Voice controls
        this.listenBtn = document.getElementById('listenBtn');
        this.listenBtnText = document.getElementById('listenBtnText');
        this.listeningIndicator = document.getElementById('listeningIndicator');
        this.interimText = document.getElementById('interimText');
        this.pushToTalkToggle = document.getElementById('pushToTalkToggle');
        this.pushToTalkKey = document.getElementById('pushToTalkKey');
        this.pushToTalkStatus = document.getElementById('pushToTalkStatus');
        this.pushToTalkStatusText = document.getElementById('pushToTalkStatusText');
        this.utteranceInput = document.getElementById('utteranceInput');
        this.sendBtn = document.getElementById('sendBtn');

        // System info
        this.systemInfo = null;

        // Speech recognition
        this.recognition = null;
        this.isListening = false;
        this.isPushToTalkMode = localStorage.getItem('pushToTalkMode') === 'true' || false;
        this.isPushToTalkEnabled = false;
        this.isPushToTalkKeyPressed = false;
        this.pushToTalkKeyCode = localStorage.getItem('pushToTalkKey') || 'Space';
        this.isSendingMessage = false; // Flag to prevent duplicate text message submissions
        this.wasListeningBeforeTTS = false; // Track listening state before TTS
        this.initializeSpeechRecognition();

        // Speech synthesis
        this.initializeSpeechSynthesis();

        // Server-Sent Events for TTS
        this.initializeTTSEvents();

        // TTS controls
        this.languageSelect = document.getElementById('languageSelect');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.testTTSBtn = document.getElementById('testTTSBtn');
        // Voice responses are always enabled now
        this.voiceOptions = document.getElementById('voiceOptions');
        this.localVoicesGroup = document.getElementById('localVoicesGroup');
        this.cloudVoicesGroup = document.getElementById('cloudVoicesGroup');
        this.rateWarning = document.getElementById('rateWarning');
        this.systemVoiceInfo = document.getElementById('systemVoiceInfo');

        // Load saved preferences
        this.loadPreferences();

        this.setupEventListeners();
        this.setupDashboardEventListeners();
        this.setupKeyboardEventListeners();
        this.loadData();
        this.loadSystemInfo();
        this.loadActivityFeed();
        this.renderSystemStats();

        // Auto-refresh every 2 seconds
        setInterval(() => {
            this.loadData();
            this.loadSystemInfo();
            this.loadActivityFeed();
        }, 5000);
    }

    initializeSpeechRecognition() {
        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('Speech recognition not supported in this browser');
            this.listenBtn.disabled = true;
            this.listenBtnText.textContent = 'Not Supported';
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;

        // Handle results
        this.recognition.onresult = (event) => {
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    // User paused - send as complete utterance
                    this.sendVoiceUtterance(transcript);
                    // Restore placeholder text
                    this.interimText.textContent = 'Start speaking and your words will appear here...';
                    this.interimText.classList.remove('active');
                } else {
                    // Still speaking - show interim results
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                this.interimText.textContent = interimTranscript;
                this.interimText.classList.add('active');
            }
        };

        // Handle errors
        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);

            if (event.error === 'no-speech') {
                // Continue listening
                return;
            }

            if (event.error === 'not-allowed') {
                alert('Microphone access denied. Please allow microphone access to use voice input.');
            } else {
                alert(`Speech recognition error: ${event.error}`);
            }

            this.stopListening();
        };

        // Handle end
        this.recognition.onend = () => {
            if (this.isListening) {
                // Restart recognition to continue listening
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error('Failed to restart recognition:', e);
                    this.stopListening();
                }
            }
        };
    }

    setupKeyboardEventListeners() {
        // Push-to-talk with configurable key
        document.addEventListener('keydown', (event) => {
            // Only handle configured key in push-to-talk mode when enabled and if not typing in input field
            if (this.isPushToTalkMode && this.isPushToTalkEnabled && event.code === this.pushToTalkKeyCode && !this.isTypingInInputField(event.target)) {
                event.preventDefault();
                if (!this.isPushToTalkKeyPressed && !this.isListening) {
                    this.isPushToTalkKeyPressed = true;
                    this.updatePushToTalkStatus('🎤 Listening...');
                    this.startListening();
                    this.interimText.textContent = `Hold ${this.getKeyName()} and speak...`;
                    this.interimText.classList.add('active');
                }
            }
        });

        document.addEventListener('keyup', (event) => {
            if (this.isPushToTalkMode && this.isPushToTalkEnabled && event.code === this.pushToTalkKeyCode) {
                event.preventDefault();
                if (this.isPushToTalkKeyPressed && this.isListening) {
                    this.isPushToTalkKeyPressed = false;
                    this.updatePushToTalkStatus('Ready - Hold key to talk');
                    this.stopListening();
                }
            }
        });
    }

    isTypingInInputField(target) {
        return target && (
            target.tagName === 'INPUT' || 
            target.tagName === 'TEXTAREA' ||
            target.contentEditable === 'true' ||
            target.id === 'utteranceInput'
        );
    }

    setupEventListeners() {
        if (this.refreshBtn) this.refreshBtn.addEventListener('click', () => this.loadData());
        if (this.clearAllBtn) this.clearAllBtn.addEventListener('click', () => this.clearAllUtterances());
        if (this.listenBtn) this.listenBtn.addEventListener('click', () => this.toggleListening());

        // Push-to-talk toggle
        if (this.pushToTalkToggle) {
            this.pushToTalkToggle.addEventListener('change', (e) => {
                this.isPushToTalkMode = e.target.checked;
                localStorage.setItem('pushToTalkMode', this.isPushToTalkMode);
                this.updateListenButtonText();
                this.updatePushToTalkUI();
                
                // Stop listening if currently listening in push-to-talk mode
                if (this.isPushToTalkMode && this.isListening) {
                    this.stopListening();
                }
            });
        }

        // Push-to-talk key selection
        if (this.pushToTalkKey) {
            this.pushToTalkKey.addEventListener('change', (e) => {
                this.pushToTalkKeyCode = e.target.value;
                localStorage.setItem('pushToTalkKey', this.pushToTalkKeyCode);
                this.updatePushToTalkStatus(`Ready - Hold ${this.getKeyName()} to talk`);
            });
        }

        // Text input
        if (this.sendBtn) this.sendBtn.addEventListener('click', () => this.sendTextMessage());
        if (this.utteranceInput) {
            this.utteranceInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.sendTextMessage();
                }
            });
        }
        

        // Language filter
        if (this.languageSelect) {
            this.languageSelect.addEventListener('change', () => {
                // Save language preference
                this.savedLanguage = this.languageSelect.value;
                localStorage.setItem('selectedLanguage', this.savedLanguage);
                // Repopulate voice list with filtered voices
                this.populateVoiceList();
            });
        }

        // TTS controls
        if (this.voiceSelect) {
            this.voiceSelect.addEventListener('change', (e) => {
                this.selectedVoice = e.target.value;
                // Save selected voice to localStorage
                localStorage.setItem('selectedVoice', this.selectedVoice);
                this.updateVoicePreferences();
                this.updateVoiceWarnings();
            });
        }

        if (this.speechRateSlider) {
            this.speechRateSlider.addEventListener('input', (e) => {
                this.speechRate = parseFloat(e.target.value);
                if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
                // Save rate to localStorage
                localStorage.setItem('speechRate', this.speechRate.toString());
            });
        }

        if (this.speechRateInput) {
            this.speechRateInput.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                    value = Math.max(0.5, Math.min(5, value)); // Clamp to valid range
                    this.speechRate = value;
                    if (this.speechRateSlider) this.speechRateSlider.value = value.toString();
                    this.speechRateInput.value = value.toFixed(1);
                    // Save rate to localStorage
                    localStorage.setItem('speechRate', this.speechRate.toString());
                }
            });
        }

        if (this.testTTSBtn) {
            this.testTTSBtn.addEventListener('click', () => {
                this.speakText('This is Voice Mode for Claude Code. How can I help you today?');
            });
        }

        // Voice responses always enabled, no toggle needed
    }


    async loadData() {
        try {
            // Load utterances
            const utterancesResponse = await fetch(`${this.baseUrl}/api/utterances?limit=20`);
            if (utterancesResponse.ok) {
                const data = await utterancesResponse.json();
                this.updateUtterancesList(data.utterances);
            }
        } catch (error) {
            console.error('Failed to load data:', error);
        }
    }

    updateUtterancesList(utterances) {
        // Convert utterances to chat messages format
        // Keep existing messages that are not yet persisted (like recent speak events)
        const recentMessages = this.messages.filter(msg => 
            msg.type === 'assistant' && 
            !msg.persisted // Only keep messages that aren't persisted yet, regardless of time
        );
        this.messages = [];
        
        // Create new messages array with server data
        const newMessages = [];
        
        utterances.forEach(utterance => {
            // Add user message
            newMessages.push({
                type: 'user',
                text: utterance.text,
                timestamp: utterance.timestamp,
                status: utterance.status,
                persisted: true
            });
            
            // If there's a response, add assistant message
            if (utterance.response) {
                newMessages.push({
                    type: 'assistant', 
                    text: utterance.response,
                    timestamp: utterance.timestamp,
                    persisted: true
                });
            }
        });

        // Check which recent messages are now persisted and mark them as such
        const existingTexts = new Set(newMessages.filter(m => m.type === 'assistant').map(m => m.text));
        const stillUnpersistedMessages = [];
        
        recentMessages.forEach(msg => {
            if (existingTexts.has(msg.text)) {
                // This message is now persisted on server, don't add it to unpersisted list
                console.log('🔄 [UPDATE] Message now persisted:', msg.text.substring(0, 50));
            } else {
                // Still not persisted, keep it
                stillUnpersistedMessages.push(msg);
            }
        });
        
        console.log('🔄 [UPDATE] Recent messages before filter:', recentMessages.length);
        console.log('🔄 [UPDATE] Still unpersisted messages:', stillUnpersistedMessages.length);
        console.log('🔄 [UPDATE] Server messages:', newMessages.length);
        
        // Combine all messages and sort by timestamp (oldest to newest)
        this.messages = [...newMessages, ...stillUnpersistedMessages].sort((a, b) => {
            return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        });
        console.log('🔄 [UPDATE] Final message count:', this.messages.length);
        
        this.renderChatMessages();
        
        // Check if all messages are pending
        const allPending = utterances.every(u => u.status === 'pending');
        if (allPending && utterances.length > 0) {
            this.infoMessage.style.display = 'block';
        } else {
            this.infoMessage.style.display = 'none';
        }
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString(); // Use full date and time with local timezone
    }

    renderChatMessages() {
        console.log('🖥️ [CHAT] Rendering chat messages, count:', this.messages.length);
        const container = this.chatContainer;
        if (!container) {
            console.error('🖥️ [CHAT] Chat container not found!');
            return;
        }

        if (this.messages.length === 0) {
            console.log('🖥️ [CHAT] No messages, showing empty state');
            container.innerHTML = '<div class="empty-state">Start a conversation by speaking or typing...</div>';
            return;
        }

        container.innerHTML = this.messages.map(message => `
            <div class="message-bubble ${message.type}">
                <div class="message-text">${this.escapeHtml(message.text)}</div>
                <div class="message-time">${this.formatChatTime(message.timestamp)}</div>
                ${message.status ? `<div class="message-status status-${message.status}">${message.status.toUpperCase()}</div>` : ''}
            </div>
        `).join('') + '<div class="typing-indicator" id="typingIndicator"><div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    formatChatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    showTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.style.display = 'block';
            this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
        }
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.style.display = 'none';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    toggleListening() {
        if (this.isPushToTalkMode) {
            // In push-to-talk mode, toggle between enabled/disabled state
            this.isPushToTalkEnabled = !this.isPushToTalkEnabled;
            this.updateListenButtonText();
            
            // If disabling push-to-talk while listening, stop listening
            if (!this.isPushToTalkEnabled && this.isListening) {
                this.stopListening();
            }
        } else {
            // In normal mode, toggle listening
            if (this.isListening) {
                this.stopListening();
            } else {
                this.startListening();
            }
        }
    }

    updateListenButtonText() {
        if (this.isPushToTalkMode) {
            if (this.isPushToTalkEnabled) {
                this.listenBtnText.textContent = `Push-to-Talk Ready (Hold ${this.getKeyName()})`;
                this.listenBtn.style.background = '#28A745';
            } else {
                this.listenBtnText.textContent = 'Enable Push-to-Talk';
                this.listenBtn.style.background = '#6C757D';
            }
        } else {
            if (this.isListening) {
                this.listenBtnText.textContent = 'Stop Listening';
                this.listenBtn.style.background = '#DC3545';
            } else {
                this.listenBtnText.textContent = 'Start Listening';
                this.listenBtn.style.background = '#28A745';
            }
        }
    }

    getKeyName() {
        const keyMap = {
            'Space': 'Space',
            'KeyT': 'T',
            'KeyV': 'V', 
            'KeyB': 'B'
        };
        return keyMap[this.pushToTalkKeyCode] || this.pushToTalkKeyCode;
    }

    updatePushToTalkStatus(message) {
        if (this.pushToTalkStatusText) {
            this.pushToTalkStatusText.textContent = message;
        }
    }

    updatePushToTalkUI() {
        if (this.isPushToTalkMode && this.isPushToTalkEnabled) {
            this.pushToTalkStatus.style.display = 'block';
            this.updatePushToTalkStatus(`Ready - Hold ${this.getKeyName()} to talk`);
        } else {
            this.pushToTalkStatus.style.display = 'none';
        }
    }

    async sendTextMessage() {
        const text = this.utteranceInput.value.trim();
        if (!text) return;

        // Prevent duplicate submissions
        if (this.isSendingMessage) {
            this.debugLog('Already sending message, ignoring duplicate call');
            return;
        }

        this.isSendingMessage = true;
        this.debugLog('Sending text message:', text);

        try {
            await this.sendVoiceUtterance(text);
            this.utteranceInput.value = ''; // Clear input after sending
        } catch (error) {
            console.error('Failed to send text message:', error);
        } finally {
            // Reset flag after a short delay to prevent rapid duplicate sends
            setTimeout(() => {
                this.isSendingMessage = false;
            }, 100);
        }
    }

    async startListening() {
        if (!this.recognition) {
            alert('Speech recognition not supported in this browser');
            return;
        }

        try {
            this.recognition.start();
            this.isListening = true;
            this.listenBtn.classList.add('listening');
            this.listenBtnText.textContent = 'Stop Listening';
            this.listeningIndicator.classList.add('active');
            this.debugLog('Started listening');

            // Notify server that voice input is active
            await this.updateVoiceInputState(true);
        } catch (e) {
            console.error('Failed to start recognition:', e);
            alert('Failed to start speech recognition. Please try again.');
        }
    }

    async stopListening() {
        if (this.recognition) {
            this.isListening = false;
            this.recognition.stop();
            this.listenBtn.classList.remove('listening');
            this.listenBtnText.textContent = 'Start Listening';
            this.listeningIndicator.classList.remove('active');
            this.interimText.textContent = 'Start speaking and your words will appear here...';
            this.interimText.classList.remove('active');
            this.debugLog('Stopped listening');

            // Notify server that voice input is no longer active
            await this.updateVoiceInputState(false);
        }
    }

    async sendVoiceUtterance(text) {
        const trimmedText = text.trim();
        if (!trimmedText) return;

        // Console log for voice input
        console.log(`🎤 [VOICE INPUT] "${trimmedText}"`);
        console.log(`   📤 Sending to server...`);
        
        this.debugLog('Sending voice utterance:', trimmedText);

        // Add user message to chat
        this.addUserMessage(trimmedText);
        
        // Show typing indicator
        this.showTypingIndicator();

        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: trimmedText,
                    timestamp: new Date().toISOString()
                }),
            });

            if (response.ok) {
                const data = await response.json();
                
                // Console log for successful voice input submission
                if (data.success) {
                    console.log(`   ✅ Voice input sent successfully`);
                    if (data.sessionName) {
                        console.log(`   📍 Routed to session: ${data.sessionName} (${data.sessionId})`);
                    } else {
                        console.log(`   📍 Routed to global queue`);
                    }
                }
                
                this.loadData(); // Refresh the list
            } else {
                const error = await response.json();
                console.log(`   ❌ Failed to send voice input:`, error);
                console.error('Error sending voice utterance:', error);
                this.hideTypingIndicator();
            }
        } catch (error) {
            console.error('Failed to send voice utterance:', error);
            this.hideTypingIndicator();
        }
    }
    
    addUserMessage(text) {
        console.log('👤 [CHAT] Adding user message:', text);
        this.messages.push({
            type: 'user',
            text: text,
            timestamp: new Date().toISOString(),
            status: 'pending'
        });
        // Sort messages by timestamp to maintain chronological order
        this.messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        console.log('👤 [CHAT] Total messages:', this.messages.length);
        this.renderChatMessages();
    }

    async clearAllUtterances() {

        this.clearAllBtn.disabled = true;
        this.clearAllBtn.textContent = 'Clearing...';

        try {
            const response = await fetch(`${this.baseUrl}/api/utterances`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (response.ok) {
                const result = await response.json();
                this.messages = []; // Clear chat messages
                this.renderChatMessages(); // Refresh chat display
                this.loadData(); // Refresh the list
                this.debugLog('Cleared all utterances:', result);
            } else {
                const error = await response.json();
                alert(`Error: ${error.error || 'Failed to clear utterances'}`);
            }
        } catch (error) {
            console.error('Failed to clear utterances:', error);
            alert('Failed to clear utterances. Make sure the server is running.');
        } finally {
            this.clearAllBtn.disabled = false;
            this.clearAllBtn.textContent = 'Clear All';
        }
    }

    debugLog(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    initializeSpeechSynthesis() {
        // Check for browser support
        if (!window.speechSynthesis) {
            console.warn('Speech synthesis not supported in this browser');
            return;
        }

        // Get available voices
        this.voices = [];
        const loadVoices = () => {
            this.voices = window.speechSynthesis.getVoices();
            this.debugLog('Available voices loaded:', this.voices.length);
            if (this.voices.length > 0) {
                this.populateVoiceList();
            } else {
                // Retry after a short delay if no voices found
                setTimeout(() => {
                    this.voices = window.speechSynthesis.getVoices();
                    this.debugLog('Retry - Available voices loaded:', this.voices.length);
                    if (this.voices.length > 0) {
                        this.populateVoiceList();
                    }
                }, 100);
            }
        };

        // Load voices initially and on change
        loadVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }

        // Set default voice preferences
        this.speechRate = 1.0;
        this.speechPitch = 1.0;
        this.selectedVoice = localStorage.getItem('selectedVoice') || 'system';
    }

    initializeTTSEvents() {
        // Initialize both WebSocket (for unified speak events) and SSE (for other events)
        this.initializeWebSocket();
        this.initializeSSE();
    }

    initializeWebSocket() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
        
        this.webSocket = new WebSocket(wsUrl);

        this.webSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('🔊 [WEBSOCKET] Received message:', data);
                this.debugLog('WebSocket Event:', data);

                if (data.type === 'speak' && data.text) {
                    console.log('🔊 [TTS] Processing speak event:', data.text);
                    this.handleUnifiedSpeakEvent(data);
                } else {
                    console.log('🔊 [WEBSOCKET] Non-speak message type:', data.type);
                }
            } catch (error) {
                console.error('Failed to parse WebSocket event:', error);
            }
        };

        this.webSocket.onerror = (error) => {
            console.log(`🔗 [WEBSOCKET] ❌ Connection error:`, error);
            console.error('WebSocket connection error:', error);
        };

        this.webSocket.onopen = () => {
            console.log(`🔗 [WEBSOCKET] ✅ Connected to ${wsUrl}`);
            this.debugLog('WebSocket connected');
        };

        this.webSocket.onclose = () => {
            console.log(`🔗 [WEBSOCKET] 🔄 Disconnected, attempting reconnect in 2s...`);
            this.debugLog('WebSocket disconnected, attempting reconnect...');
            // Reconnect after 2 seconds
            setTimeout(() => this.initializeWebSocket(), 2000);
        };
    }

    initializeSSE() {
        // Connect to Server-Sent Events endpoint for other events (waitStatus, sessionUpdate)
        this.eventSource = new EventSource(`${this.baseUrl}/api/tts-events`);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.debugLog('SSE Event:', data);

                if (data.type === 'waitStatus') {
                    this.handleWaitStatus(data.isWaiting);
                } else if (data.type === 'sessionUpdate') {
                    this.handleSessionUpdate(data);
                }
                // Note: 'speak' events now come through WebSocket
            } catch (error) {
                console.error('Failed to parse SSE event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            // Will automatically reconnect
        };

        this.eventSource.onopen = () => {
            this.debugLog('SSE Events connected');
            // Sync state when connection is established (includes reconnections)
            this.syncStateWithServer();
        };
    }

    populateLanguageFilter() {
        if (!this.languageSelect) return;
        
        if (!this.voices || this.voices.length === 0) {
            // Show loading state
            this.languageSelect.innerHTML = '<option value="">Loading languages...</option>';
            return;
        }

        // Get saved selection first, then current selection
        const currentSelection = this.savedLanguage || this.languageSelect.value || 'en-US';

        // Clear existing options
        this.languageSelect.innerHTML = '';

        // Add "All Languages" option
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All Languages';
        this.languageSelect.appendChild(allOption);

        // Collect unique language codes
        const languageCodes = new Set();
        this.voices.forEach(voice => {
            languageCodes.add(voice.lang);
        });

        // Sort and add language codes
        Array.from(languageCodes).sort().forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            this.languageSelect.appendChild(option);
        });

        // Restore selection
        this.languageSelect.value = currentSelection;
        if (this.languageSelect.value !== currentSelection) {
            // If saved selection not available, try en-US
            this.languageSelect.value = 'en-US';
            if (this.languageSelect.value !== 'en-US') {
                // If en-US also not available, use 'all'
                this.languageSelect.value = 'all';
            }
        }
        
        // Save the final selection to localStorage
        localStorage.setItem('selectedLanguage', this.languageSelect.value);
    }

    populateVoiceList() {
        if (!this.voiceSelect || !this.localVoicesGroup || !this.cloudVoicesGroup) return;

        // First populate the language filter
        this.populateLanguageFilter();

        // Clear existing browser voice options
        this.localVoicesGroup.innerHTML = '';
        this.cloudVoicesGroup.innerHTML = '';

        // List of voices to exclude (novelty, Eloquence, and non-premium voices)
        const excludedVoices = [
            // Eloquence voices
            'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
            // Novelty voices
            'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
            'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper',
            'Wobble', 'Zarvox',
            // Voices without premium options
            'Fred', 'Junior', 'Kathy', 'Ralph'
        ];

        // Get selected language filter
        const selectedLanguage = this.languageSelect ? this.languageSelect.value : 'en-US';

        // Filter voices based on selected language
        this.voices.forEach((voice, index) => {
            const voiceLang = voice.lang;
            let shouldInclude = false;

            if (selectedLanguage === 'all') {
                // Include all languages
                shouldInclude = true;
            } else {
                // Check if voice matches selected language/locale
                shouldInclude = voiceLang === selectedLanguage;
            }

            if (shouldInclude) {
                // Check if voice should be excluded
                const voiceName = voice.name;
                const isExcluded = excludedVoices.some(excluded =>
                    voiceName.toLowerCase().startsWith(excluded.toLowerCase())
                );

                if (!isExcluded) {
                    const option = document.createElement('option');
                    option.value = `browser:${index}`;
                    // Show voice name and language code
                    option.textContent = `${voice.name} (${voice.lang})`;

                    // Categorize voices
                    if (voice.localService) {
                        this.localVoicesGroup.appendChild(option);
                        this.debugLog(voice.voiceURI);
                    } else {
                        this.cloudVoicesGroup.appendChild(option);
                    }
                }
            }
        });

        // Hide empty groups
        if (this.localVoicesGroup.children.length === 0) {
            this.localVoicesGroup.style.display = 'none';
        } else {
            this.localVoicesGroup.style.display = '';
        }

        if (this.cloudVoicesGroup.children.length === 0) {
            this.cloudVoicesGroup.style.display = 'none';
        } else {
            this.cloudVoicesGroup.style.display = '';
        }

        // Restore saved selection
        const savedVoice = localStorage.getItem('selectedVoice');
        if (savedVoice) {
            // Check if saved voice is still available
            const voiceOption = this.voiceSelect.querySelector(`option[value="${savedVoice}"]`);
            if (voiceOption) {
                this.voiceSelect.value = savedVoice;
                this.selectedVoice = savedVoice;
                this.debugLog('Restored saved voice:', savedVoice);
            } else {
                // Saved voice not available anymore, find best alternative
                this.selectBestAvailableVoice();
            }
        } else {
            // No saved voice, select best available
            this.selectBestAvailableVoice();
        }
        
        // Always save the final selection
        localStorage.setItem('selectedVoice', this.selectedVoice);

        // Update warnings based on selected voice
        this.updateVoiceWarnings();
    }

    selectBestAvailableVoice() {
        // Look for Google US English Male voice first
        let googleUSMaleIndex = -1;
        let microsoftAndrewIndex = -1;

        this.voices.forEach((voice, index) => {
            const voiceName = voice.name.toLowerCase();

            // Check for Google US English Male
            if (voiceName.includes('google') &&
                voiceName.includes('us') &&
                voiceName.includes('english')) {
                googleUSMaleIndex = index;
            }

            // Check for Microsoft Andrew Online
            if (voiceName.includes('microsoft') &&
                voiceName.includes('andrew') &&
                voiceName.includes('online')) {
                microsoftAndrewIndex = index;
            }
        });

        if (googleUSMaleIndex !== -1) {
            this.selectedVoice = `browser:${googleUSMaleIndex}`;
            this.voiceSelect.value = this.selectedVoice;
            this.debugLog('Defaulting to Google US English Male voice');
        } else if (microsoftAndrewIndex !== -1) {
            this.selectedVoice = `browser:${microsoftAndrewIndex}`;
            this.voiceSelect.value = this.selectedVoice;
            this.debugLog('Google US English Male not found, defaulting to Microsoft Andrew Online');
        } else {
            this.selectedVoice = 'system';
            this.voiceSelect.value = this.selectedVoice;
            this.debugLog('Preferred voices not found, using system default');
        }
    }

    async speakText(text) {
        console.log('🔊 [TTS] speakText called with:', text);
        // Always use browser voice (Web Speech API)
        {
            // Use browser voice
            if (!window.speechSynthesis) {
                console.error('🔊 [TTS] Speech synthesis not available');
                return;
            }

            console.log('🔊 [TTS] Speech synthesis available, proceeding...');
            // Cancel any ongoing speech
            window.speechSynthesis.cancel();

            // Create utterance
            const utterance = new SpeechSynthesisUtterance(text);

            // Set voice - use selected voice or find preferred voice
            if (this.selectedVoice && this.selectedVoice.startsWith('browser:')) {
                const voiceIndex = parseInt(this.selectedVoice.substring(8));
                if (this.voices[voiceIndex]) {
                    utterance.voice = this.voices[voiceIndex];
                }
            } else {
                // Find preferred voice based on language setting
                const preferredVoice = this.findPreferredVoice();
                if (preferredVoice) {
                    utterance.voice = preferredVoice;
                }
            }

            // Set speech properties
            utterance.rate = this.speechRate;
            utterance.pitch = this.speechPitch;

            // Event handlers
            utterance.onstart = () => {
                this.debugLog('Started speaking:', text);
                // Pause voice input during TTS
                if (this.isListening) {
                    this.wasListeningBeforeTTS = true;
                    this.stopListening();
                }
            };

            utterance.onend = () => {
                this.debugLog('Finished speaking');
                // Always resume voice input after TTS for continuous conversation
                if (this.wasListeningBeforeTTS || !this.isListening) {
                    this.wasListeningBeforeTTS = false;
                    // Start listening after a short delay to allow TTS to fully complete
                    setTimeout(() => {
                        if (!this.isListening) {
                            this.startListening();
                        }
                    }, 500);
                }
            };

            utterance.onerror = (event) => {
                console.error('Speech synthesis error:', event);
            };

            // Speak the text
            console.log('🔊 [TTS] Calling speechSynthesis.speak()');
            window.speechSynthesis.speak(utterance);
        }
    }

    loadPreferences() {
        // Voice responses are always enabled now

        // Load push-to-talk preferences
        if (this.pushToTalkToggle) {
            this.pushToTalkToggle.checked = this.isPushToTalkMode;
        }
        if (this.pushToTalkKey) {
            this.pushToTalkKey.value = this.pushToTalkKeyCode;
        }

        // Voice responses always enabled

        // Load voice settings
        const storedRate = localStorage.getItem('speechRate');
        if (storedRate !== null) {
            this.speechRate = parseFloat(storedRate);
            if (this.speechRateSlider) this.speechRateSlider.value = storedRate;
            if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        // Load selected voice (will be applied after voices load)
        this.selectedVoice = localStorage.getItem('selectedVoice') || 'system';

        // Load selected language - will be applied when populateLanguageFilter is called
        this.savedLanguage = localStorage.getItem('selectedLanguage') || 'en-US';

        // Update UI visibility
        this.updateVoiceOptionsVisibility();

        // Send preferences to server
        this.updateVoicePreferences();

        // Update warnings after preferences are loaded
        this.updateVoiceWarnings();

        // Update button text and UI based on mode
        this.updateListenButtonText();
        this.updatePushToTalkUI();
    }

    updateVoiceOptionsVisibility() {
        // Voice options always visible now
        if (this.voiceOptions) {
            this.voiceOptions.style.display = 'flex';
        }
    }

    async updateVoicePreferences() {
        const voiceResponsesEnabled = true; // Always enabled

        try {
            // Send preferences to server
            await fetch(`${this.baseUrl}/api/voice-preferences`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    voiceResponsesEnabled
                }),
            });

            this.debugLog('Voice preferences updated:', { voiceResponsesEnabled });
        } catch (error) {
            console.error('Failed to update voice preferences:', error);
        }
    }

    async updateVoiceInputState(active) {
        try {
            // Send voice input state to server
            await fetch(`${this.baseUrl}/api/voice-input-state`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ active }),
            });

            this.debugLog('Voice input state updated:', { active });
        } catch (error) {
            console.error('Failed to update voice input state:', error);
        }
    }

    async syncStateWithServer() {
        this.debugLog('Syncing state with server after reconnection');

        // Sync voice response preferences
        await this.updateVoicePreferences();

        // Sync voice input state if currently listening
        if (this.isListening) {
            await this.updateVoiceInputState(true);
        }
    }

    updateVoiceWarnings() {
        // Show/hide warnings based on selected voice
        if (this.selectedVoice === 'system') {
            // Show system voice info for Mac System Voice
            this.systemVoiceInfo.style.display = 'flex';
            this.rateWarning.style.display = 'none';
        } else if (this.selectedVoice && this.selectedVoice.startsWith('browser:')) {
            // Check voice properties
            const voiceIndex = parseInt(this.selectedVoice.substring(8));
            const voice = this.voices[voiceIndex];

            if (voice) {
                const isGoogleVoice = voice.name.toLowerCase().includes('google');
                const isLocalVoice = voice.localService === true;

                // Show appropriate warnings
                if (isGoogleVoice) {
                    // Show rate warning for Google voices
                    this.rateWarning.style.display = 'flex';
                } else {
                    this.rateWarning.style.display = 'none';
                }

                if (isLocalVoice) {
                    // Show system info for local browser voices
                    this.systemVoiceInfo.style.display = 'flex';
                } else {
                    this.systemVoiceInfo.style.display = 'none';
                }
            } else {
                // Hide both warnings if voice not found
                this.rateWarning.style.display = 'none';
                this.systemVoiceInfo.style.display = 'none';
            }
        } else {
            // Hide both warnings if no voice selected
            this.rateWarning.style.display = 'none';
            this.systemVoiceInfo.style.display = 'none';
        }
    }

    handleWaitStatus(isWaiting) {
        const listeningIndicatorText = this.listeningIndicator.querySelector('span');

        if (isWaiting) {
            // Claude is waiting for voice input - automatically start listening
            listeningIndicatorText.textContent = 'Claude is waiting for your voice input...';
            this.debugLog('Claude is waiting for voice input - auto-starting listening');
            
            // Automatically start voice recognition if not already listening
            if (!this.isListening && this.recognition) {
                this.startListening();
            }
        } else {
            // Back to normal listening state
            listeningIndicatorText.textContent = 'Listening...';
            this.debugLog('Claude finished waiting');
        }
    }

    handleSpeakEvent(data) {
        // Legacy SSE speak event handler - kept for backward compatibility
        this.handleUnifiedSpeakEvent(data);
    }

    handleUnifiedSpeakEvent(data) {
        const { text, sessionId, sessionName, instanceUrl } = data;
        
        // Console log for speak event
        console.log(`🗣️ [SPEAK EVENT] "${text}"`);
        if (sessionName && instanceUrl) {
            console.log(`   📍 Session: ${sessionName} (${sessionId})`);
            console.log(`   🌐 Instance: ${instanceUrl}`);
        } else if (sessionName) {
            console.log(`   📍 Session: ${sessionName} (${sessionId})`);
        } else {
            console.log(`   📍 No session information`);
        }
        
        // Hide typing indicator
        this.hideTypingIndicator();
        
        // Add assistant message to chat
        this.addAssistantMessage(text);
        
        
        // Speak the text
        this.speakText(text);
        
        // Log session and instance information (existing debug log)
        if (sessionName && instanceUrl) {
            this.debugLog(`Speaking from ${sessionName} (${sessionId}) on ${instanceUrl}`);
        } else if (sessionName) {
            this.debugLog(`Speaking from session: ${sessionName} (${sessionId})`);
        } else {
            this.debugLog(`Speaking (no session information)`);
        }
    }
    
    addAssistantMessage(text) {
        console.log('🤖 [CHAT] Adding assistant message:', text);
        this.messages.push({
            type: 'assistant',
            text: text,
            timestamp: new Date().toISOString(),
            persisted: false // Mark as not yet persisted to server
        });
        // Sort messages by timestamp to maintain chronological order
        this.messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        console.log('🤖 [CHAT] Total messages:', this.messages.length);
        this.renderChatMessages();
    }







    // Removed session highlighting - single session system



    // New session management methods
    async loadSystemInfo() {
        try {
            const response = await fetch(`${this.baseUrl}/api/system`);
            if (response.ok) {
                this.systemInfo = await response.json();
                this.updateSystemInfoDisplay();
            }
        } catch (error) {
            console.error('Failed to load system info:', error);
        }
    }

    async loadActivityFeed() {
        try {
            const response = await fetch(`${this.baseUrl}/api/activity?limit=20`);
            if (response.ok) {
                const data = await response.json();
                this.activityFeed = data.activities;
                this.updateActivityFeedDisplay();
            }
        } catch (error) {
            console.error('Failed to load activity feed:', error);
        }
    }

    async loadSessionDetails(sessionId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/details`);
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.error('Failed to load session details:', error);
        }
        return null;
    }

    updateSystemInfoDisplay() {
        if (!this.systemInfo) return;

        // Create or update system info section
        let systemInfoContainer = document.getElementById('systemInfoContainer');
        if (!systemInfoContainer) {
            this.createSystemInfoUI();
            systemInfoContainer = document.getElementById('systemInfoContainer');
        }

        const { instance, sessions, voice, memory } = this.systemInfo;
        
        const systemInfoHTML = `
            <div class="system-stats-grid">
                <div class="system-stat-card">
                    <div class="stat-icon">🖥️</div>
                    <div class="stat-content">
                        <div class="stat-label">Instance</div>
                        <div class="stat-value">${instance.role.toUpperCase()}</div>
                        <div class="stat-detail">Port ${instance.port} • PID ${instance.pid}</div>
                    </div>
                </div>
                <div class="system-stat-card">
                    <div class="stat-icon">📁</div>
                    <div class="stat-content">
                        <div class="stat-label">Sessions</div>
                        <div class="stat-value">${sessions.active}/${sessions.total}</div>
                        <div class="stat-detail">Active sessions</div>
                    </div>
                </div>
                <div class="system-stat-card">
                    <div class="stat-icon">🎤</div>
                    <div class="stat-content">
                        <div class="stat-label">Voice Clients</div>
                        <div class="stat-value">${voice.activeClients}</div>
                        <div class="stat-detail">Connected browsers</div>
                    </div>
                </div>
                <div class="system-stat-card">
                    <div class="stat-icon">💾</div>
                    <div class="stat-content">
                        <div class="stat-label">Memory</div>
                        <div class="stat-value">${Math.round(memory.heapUsed / 1024 / 1024)}MB</div>
                        <div class="stat-detail">Heap used</div>
                    </div>
                </div>
            </div>
            <div class="system-uptime">
                <span>Uptime: ${this.formatUptime(instance.uptime)} • ${instance.nodeVersion} • ${instance.platform}</span>
            </div>
        `;

        systemInfoContainer.innerHTML = systemInfoHTML;
    }

    updateActivityFeedDisplay() {
        // Create or update activity feed section
        let activityContainer = document.getElementById('activityFeedContainer');
        if (!activityContainer) {
            this.createActivityFeedUI();
            activityContainer = document.getElementById('activityFeedContainer');
        }

        const feedList = document.getElementById('activityFeedList');
        if (!feedList) return;

        if (this.activityFeed.length === 0) {
            feedList.innerHTML = '<div class="empty-state">No recent activity.</div>';
            return;
        }

        feedList.innerHTML = this.activityFeed.map(activity => `
            <div class="activity-feed-item">
                <div class="activity-icon">${this.getActivityIcon(activity.type)}</div>
                <div class="activity-content">
                    <div class="activity-header">
                        <span class="activity-session">${activity.sessionName || 'Unknown Session'}</span>
                        <span class="activity-time">${new Date(activity.timestamp).toLocaleString()}</span>
                    </div>
                    <div class="activity-text">${this.escapeHtml(activity.content || 'No content')}</div>
                    <div class="activity-meta">
                        <span class="activity-type">${activity.type.replace('_', ' ')}</span>
                        <span class="activity-status status-${activity.status}">${activity.status}</span>
                    </div>
                </div>
            </div>
        `).join('');
    }

    createSystemInfoUI() {
        const container = document.querySelector('.container');
        if (!container) return;

        const systemInfoHTML = `
            <div id="systemInfoContainer" class="section system-info-section">
                <div class="header">
                    <h2>📊 System Overview</h2>
                </div>
                <div class="system-info-content">
                    <!-- Content will be populated by updateSystemInfoDisplay -->
                </div>
            </div>
        `;

        // Insert at the beginning
        container.insertAdjacentHTML('afterbegin', systemInfoHTML);
    }

    createActivityFeedUI() {
        const container = document.querySelector('.container');
        if (!container) return;

        const activityFeedHTML = `
            <div id="activityFeedContainer" class="section activity-feed-section">
                <div class="header">
                    <h2>📋 Recent Activity</h2>
                    <button id="refreshActivityBtn" class="btn secondary-btn">Refresh</button>
                </div>
                <div id="activityFeedList" class="activity-feed-list">
                    <div class="empty-state">Loading activity...</div>
                </div>
            </div>
        `;

        // Insert before voice feed
        const voiceFeedContainer = document.getElementById('voiceFeedContainer');
        if (voiceFeedContainer) {
            voiceFeedContainer.insertAdjacentHTML('beforebegin', activityFeedHTML);
        } else {
            // Insert before sessions section as fallback
            const sessionsSection = document.querySelector('.sessions-section');
            if (sessionsSection) {
                sessionsSection.insertAdjacentHTML('beforebegin', activityFeedHTML);
            }
        }

        // Add event listener
        const refreshBtn = document.getElementById('refreshActivityBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadActivityFeed());
        }
    }

    getActivityIcon(type) {
        const icons = {
            'voice_input': '🎤',
            'tool_use': '🔧',
            'session_start': '▶️',
            'session_end': '⏹️',
            'error': '❌'
        };
        return icons[type] || '📝';
    }

    formatUptime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    // Enhanced session card with more details
    async createEnhancedSessionCard(session, isActive) {
        const lastActivityTime = new Date(session.lastActivity).toLocaleString();
        const statusClass = session.isActive ? 'active' : 'inactive';
        const projectName = session.projectName || 'Unknown Project';
        const projectPath = session.projectPath || 'Unknown Path';

        // Try to get detailed session info
        const details = await this.loadSessionDetails(session.id);
        const gitInfo = details?.gitInfo;

        return `
            <div class="session-card enhanced ${statusClass} ${isActive ? 'selected' : ''}" data-session-id="${session.id}">
                <div class="session-header">
                    <h4 class="session-title">${projectName}</h4>
                    ${gitInfo ? `
                        <div class="git-info">
                            <span class="git-branch">🌿 ${gitInfo.branch}</span>
                            <span class="git-commit">${gitInfo.commit}</span>
                            ${gitInfo.hasChanges ? '<span class="git-changes">⚠️</span>' : ''}
                        </div>
                    ` : ''}
                </div>
                <div class="session-path">${projectPath}</div>
                <div class="session-stats">
                    <div class="session-stat">
                        <div class="session-stat-icon stat-pending"></div>
                        <span>${session.pendingUtterances} pending</span>
                    </div>
                    <div class="session-stat">
                        <div class="session-stat-icon stat-total"></div>
                        <span>${session.totalUtterances} total</span>
                    </div>
                    ${gitInfo && gitInfo.hasChanges ? `
                        <div class="session-stat">
                            <div class="session-stat-icon stat-changes"></div>
                            <span>${gitInfo.changedFiles} changes</span>
                        </div>
                    ` : ''}
                </div>
                <div class="session-activity">Last activity: ${lastActivityTime}</div>
                <div class="session-actions">
                    <button class="session-btn" data-action="details">Details</button>
                    <button class="session-btn" data-action="clear">Clear Utterances</button>
                    <button class="session-btn danger" data-action="remove">Remove</button>
                </div>
            </div>
        `;
    }

    // Dashboard-specific event listeners
    setupDashboardEventListeners() {
        // Voice settings toggle
        if (this.voiceSettingsBtn) {
            this.voiceSettingsBtn.addEventListener('click', () => {
                this.voiceSection.style.display = this.voiceSection.style.display === 'none' ? 'block' : 'none';
            });
        }

        // Hide voice section
        if (this.hideVoiceBtn) {
            this.hideVoiceBtn.addEventListener('click', () => {
                this.voiceSection.style.display = 'none';
            });
        }

        // Activity refresh
        if (this.refreshActivityBtn) {
            this.refreshActivityBtn.addEventListener('click', () => {
                this.loadActivityFeed();
            });
        }
    }

    // Render system stats
    renderSystemStats() {
        if (!this.systemInfo) return;

        const stats = [
            {
                icon: '■',
                label: 'role',
                value: this.systemInfo.instance.role,
                detail: `:${this.systemInfo.instance.port}`,
                className: 'system'
            },
            {
                icon: '▶',
                label: 'sessions',
                value: `${this.systemInfo.sessions.active}/${this.systemInfo.sessions.total}`,
                detail: 'active',
                className: 'sessions'
            },
            {
                icon: '●',
                label: 'voice',
                value: this.systemInfo.voice.enabled ? 'enabled' : 'disabled',
                detail: `${this.systemInfo.voice.activeClients}`,
                className: 'voice'
            },
            {
                icon: '◆',
                label: 'mem',
                value: `${Math.round(this.systemInfo.memory.heapUsed / 1024 / 1024)}M`,
                detail: `/${Math.round(this.systemInfo.memory.rss / 1024 / 1024)}M`,
                className: 'activity'
            }
        ];

        if (this.systemStatsFooter) {
            this.systemStatsFooter.innerHTML = stats.map(stat => `
                <div class="system-stat-card ${stat.className}">
                    <span class="stat-label">${stat.label}:</span>
                    <span class="stat-value">${stat.value}</span><span class="stat-detail">${stat.detail}</span>
                </div>
            `).join('  |  ');
        }
    }

    // Enhanced activity feed rendering
    renderActivityFeed() {
        const activityFeedList = document.getElementById('activityFeedList');
        if (!activityFeedList) {
            console.log('Activity feed list element not found, skipping render');
            return;
        }

        if (!this.activityFeed || this.activityFeed.length === 0) {
            activityFeedList.innerHTML = '<div class="empty-state">No recent activity.</div>';
            return;
        }

        activityFeedList.innerHTML = this.activityFeed.slice(0, 10).map(activity => {
            const timeAgo = this.getTimeAgo(new Date(activity.timestamp));
            const statusClass = `activity-status status-${activity.status}`;
            
            return `
                <div class="activity-feed-item">
                    <div class="activity-icon">🎤</div>
                    <div class="activity-content">
                        <div class="activity-header">
                            <div class="activity-session">${activity.sessionName || 'Unknown Session'}</div>
                            <div class="activity-time">${timeAgo}</div>
                        </div>
                        <div class="activity-text">${activity.content || 'No content'}</div>
                        <div class="activity-meta">
                            <span class="activity-type">${activity.type.replace('_', ' ')}</span>
                            <span class="${statusClass}">${activity.status.toUpperCase()}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Helper function to get human-readable time ago
    getTimeAgo(date) {
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);
        
        if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
        return `${Math.floor(diffInSeconds / 86400)}d ago`;
    }

    // Override loadSystemInfo to update dashboard
    async loadSystemInfo() {
        try {
            const response = await fetch(`${this.baseUrl}/api/system`);
            if (response.ok) {
                this.systemInfo = await response.json();
                this.renderSystemStats();
            }
        } catch (error) {
            console.error('Failed to load system info:', error);
        }
    }

    // Override loadActivityFeed to update dashboard
    async loadActivityFeed() {
        try {
            const response = await fetch(`${this.baseUrl}/api/activity?limit=20`);
            if (response.ok) {
                const data = await response.json();
                this.activityFeed = data.activities;
                this.renderActivityFeed();
            }
        } catch (error) {
            console.error('Failed to load activity feed:', error);
        }
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VoiceHooksClient();
});