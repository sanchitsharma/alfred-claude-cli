#!/usr/bin/osascript -l JavaScript

// Helpers
function envVar(varName) {
  return $.NSProcessInfo.processInfo.environment.objectForKey(varName).js
}

function fileExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path)
}

function fileModified(path) {
  return $.NSFileManager.defaultManager
    .attributesOfItemAtPathError(path, undefined)
    .js["NSFileModificationDate"].js
    .getTime()
}

function deleteFile(path) {
  return $.NSFileManager.defaultManager.removeItemAtPathError(path, undefined)
}

function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, undefined)
}

function readFile(path) {
  return $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, undefined).js
}

function readChat(path) {
  return JSON.parse(readFile(path))
}

function appendChat(path, message) {
  const ongoingChat = readChat(path).concat(message)
  writeFile(path, JSON.stringify(ongoingChat))
}

// MARK: markdown chat
function markdownChat(messages, ignoreLastInterrupted = true) {
  return messages.reduce((accumulator, current, index, allMessages) => {
    if (current["role"] === "assistant")
      return `${accumulator}${current["content"]}\n\n`

    if (current["role"] === "user") {
      const userMessage = current["content"].split("\n").map(line => `### ${line}`).join("\n")
      const userTwice = allMessages[index + 1]?.["role"] === "user"
      const lastMessage = index === allMessages.length - 1

      return userTwice || (lastMessage && !ignoreLastInterrupted) ?
        `${accumulator}${userMessage}\n\n[Answer Interrupted]\n\n` :
        `${accumulator}${userMessage}\n\n`
    }

    return accumulator
  }, "")
}

// MARK: session helpers
function readSessionId(sessionFile) {
  if (!fileExists(sessionFile)) return null
  const id = readFile(sessionFile).trim()
  return id.length > 0 ? id : null
}

// MARK: start stream
// Launches the claude CLI as a subprocess, piping stdout to streamFile.
// Uses --resume <session_id> for multi-turn context (no full history in prompt).
// Args are passed directly to execv() — no shell, no injection risk.
function startStream(claudeCLI, model, systemPrompt, ongoingChat, streamFile, pidStreamFile, sessionFile, workdir) {
  $.NSFileManager.defaultManager.createFileAtPathContentsAttributes($(streamFile), $(""), undefined)

  const task = $.NSTask.alloc.init

  // Only the latest message goes to the CLI — history is server-side via --resume
  const latestMessage = ongoingChat[ongoingChat.length - 1].content

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model
  ]

  // Skip tool-permission prompts (config toggle, on by default).
  // Alfred sets checkbox vars to "1"/"0"; treat anything but "0" as enabled.
  if (envVar("claude_skip_permissions") !== "0") {
    args.push("--dangerously-skip-permissions")
  }

  const sessionId = readSessionId(sessionFile)

  // System prompt only on first message of a session (--resume preserves it after that)
  if (systemPrompt && systemPrompt.length > 0 && !sessionId) {
    args.push("--system-prompt", systemPrompt)
  }

  if (sessionId) {
    args.push("--resume", sessionId)
  }

  args.push(latestMessage)

  task.executableURL = $.NSURL.fileURLWithPath($(claudeCLI))
  task.arguments = args

  // Working directory the claude CLI runs in. Blank = inherit Alfred's cwd.
  // Expands a leading ~ and only sets it if the path exists.
  if (workdir && workdir.length > 0) {
    const expanded = $(workdir).stringByExpandingTildeInPath.js
    if (fileExists(expanded)) {
      task.currentDirectoryURL = $.NSURL.fileURLWithPath($(expanded))
    }
  }

  // Redirect stdout to streamFile
  const fh = $.NSFileHandle.fileHandleForWritingAtPath($(streamFile))
  task.standardOutput = fh

  // Redirect stderr to /dev/null — suppress hook noise from verbose output
  const devNull = $.NSFileHandle.fileHandleForWritingAtPath($("/dev/null"))
  task.standardError = devNull

  task.launchAndReturnError(false)
  writeFile(pidStreamFile, task.processIdentifier.toString())
}

// MARK: read stream
// Parses NDJSON from the claude CLI's stream-json output.
// assistant events are cumulative — take the latest one's text for live display.
// result event signals completion and carries the session_id for next --resume.
function readStream(streamFile, chatFile, pidStreamFile, sessionFile) {
  const streamMarker = envVar("stream_marker") === "1"

  if (streamMarker) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true },
    response: "…",
    behaviour: { response: "append" }
  })

  const streamString = fileExists(streamFile) ? readFile(streamFile) : ""

  // Parse NDJSON — each line is a JSON event
  const events = streamString
    .split("\n")
    .filter(line => line.trimStart().startsWith("{"))
    .map(line => { try { return JSON.parse(line) } catch(e) { return null } })
    .filter(Boolean)

  // assistant events contain cumulative text — extract from the latest one
  function extractText(event) {
    if (event.type !== "assistant" || !event.message) return null
    const content = event.message.content
    if (!Array.isArray(content)) return null
    // Skip thinking blocks; only grab text blocks
    const textBlock = content.find(b => b.type === "text")
    return textBlock ? textBlock.text : null
  }

  const texts = events.map(extractText).filter(t => t !== null && t.length > 0)
  const currentText = texts.length > 0 ? texts[texts.length - 1] : ""

  // result event = CLI finished
  const resultEvent = events.find(e => e.type === "result")

  if (resultEvent) {
    const sid = resultEvent.session_id
    if (sid) writeFile(sessionFile, sid)

    if (resultEvent.is_error) {
      deleteFile(streamFile)
      deleteFile(pidStreamFile)
      return JSON.stringify({
        response: `[Error: ${resultEvent.result || "Unknown error"}]  \n(${new Date().toUTCString()})`,
        behaviour: { response: "replacelast" }
      })
    }

    const responseText = resultEvent.result || currentText
    appendChat(chatFile, { role: "assistant", content: responseText })
    deleteFile(streamFile)
    deleteFile(pidStreamFile)

    return JSON.stringify({
      response: responseText,
      behaviour: { response: "replacelast", scroll: "end" }
    })
  }

  // Stall detection — no file modification for 5s means the process died or hung
  if (fileExists(streamFile)) {
    const stalled = new Date().getTime() - fileModified(streamFile) > 5000

    if (stalled) {
      if (currentText.length > 0) appendChat(chatFile, { role: "assistant", content: currentText })
      deleteFile(streamFile)
      deleteFile(pidStreamFile)
      return JSON.stringify({
        response: `${currentText} [Connection Stalled]`,
        footer: "You can ask Claude to continue",
        behaviour: { response: "replacelast", scroll: "end" }
      })
    }
  }

  // Empty file — process launched but hasn't written yet
  if (streamString.length === 0) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true }
  })

  // Still streaming — show latest text and loop
  return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true },
    response: currentText || "…",
    behaviour: { response: "replacelast", scroll: "end" }
  })
}

// MARK: main
function run(argv) {
  const typedQuery = argv[0]
  const maxEntries = 100
  const claudeCLI = envVar("claude_cli_path") || "/Applications/cmux.app/Contents/Resources/bin/claude"
  const systemPrompt = envVar("system_prompt")
  const model = envVar("gpt_model") || "sonnet"
  const workdir = envVar("claude_workdir")

  const chatFile = `${envVar("alfred_workflow_data")}/chat.json`
  const pidStreamFile = `${envVar("alfred_workflow_cache")}/pid.txt`
  const streamFile = `${envVar("alfred_workflow_cache")}/stream.txt`
  const sessionFile = `${envVar("alfred_workflow_data")}/session.txt`
  const streamingNow = envVar("streaming_now") === "1"

  if (streamingNow) return readStream(streamFile, chatFile, pidStreamFile, sessionFile)

  const previousChat = readChat(chatFile).slice(-maxEntries)

  if (fileExists(streamFile)) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(previousChat, true),
    behaviour: { scroll: "end" }
  })

  if (typedQuery.length === 0) return JSON.stringify({
    response: markdownChat(previousChat, false),
    behaviour: { scroll: "end" }
  })

  const appendQuery = { role: "user", content: typedQuery }
  const ongoingChat = previousChat.concat(appendQuery)

  startStream(claudeCLI, model, systemPrompt, ongoingChat, streamFile, pidStreamFile, sessionFile, workdir)
  appendChat(chatFile, appendQuery)

  return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(ongoingChat)
  })
}
