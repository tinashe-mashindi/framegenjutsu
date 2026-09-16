(function () {
  "use strict";

  var MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
  var SCENE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  var state = {
    providers: [],
    limits: { MIN_IN_BETWEEN: 1, MAX_IN_BETWEEN: 10 },
    defaults: {},
    uploads: { start: null, middle: null, end: null },
    stream: null,
    jobId: null,
    result: null,
    busy: false
  };

  var el = {};

  function byId(id) { return document.getElementById(id); }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  function notice(message, kind) {
    if (!message) {
      el.notice.hidden = true;
      el.notice.textContent = "";
      return;
    }
    el.notice.hidden = false;
    el.notice.className = "notice" + (kind ? " " + kind : "");
    el.notice.textContent = message;
  }

  /* ------------------------------------------------------------ theme */

  function initTheme() {
    el.themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("comicgen-theme", next); } catch (err) {}
    });
  }

  /* ----------------------------------------------------------- health */

  function loadHealth() {
    fetch("/api/health").then(function (res) { return res.json(); }).then(function (data) {
      if (data.ok) {
        el.health.className = "pill pill-ok";
        el.health.textContent = "ready";
        el.health.title = "ffmpeg: " + data.ffmpeg + "\nprojects: " + data.projectsDir;
      } else {
        el.health.className = "pill pill-bad";
        el.health.textContent = "ffmpeg missing";
        el.health.title = "ffmpeg or ffprobe was not found. Run npm install, or install ffmpeg and set FFMPEG_PATH.";
      }
    }).catch(function () {
      el.health.className = "pill pill-bad";
      el.health.textContent = "offline";
    });
  }

  /* -------------------------------------------------------- providers */

  function loadProviders() {
    return fetch("/api/providers").then(function (res) { return res.json(); }).then(function (data) {
      state.providers = data.providers || [];
      state.limits = data.limits || state.limits;
      state.defaults = data.defaults || {};
      buildProviderSelect();
      buildCountSelects();
      if (state.defaults.fps) el.fps.value = state.defaults.fps;
    });
  }

  function providerUsable(provider) {
    return !provider.requiresKey || provider.keyPresent;
  }

  function modelUsable(model) {
    return !(model.requiresPublicUrl && !state.defaults.hasPublicBaseUrl);
  }

  function buildProviderSelect() {
    el.provider.innerHTML = "";
    state.providers.forEach(function (provider) {
      var option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label + (providerUsable(provider) ? "" : " - no API key");
      option.disabled = !providerUsable(provider);
      el.provider.appendChild(option);
    });

    var preferred = null;
    try { preferred = localStorage.getItem("comicgen-provider"); } catch (err) {}
    var matches = function (provider) { return provider.id === preferred && providerUsable(provider); };
    if (preferred && state.providers.some(matches)) {
      el.provider.value = preferred;
    } else {
      var fallback = state.providers.filter(providerUsable)[0];
      if (fallback) el.provider.value = fallback.id;
    }
    buildModelSelect();
  }

  function currentProvider() {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === el.provider.value) return state.providers[i];
    }
    return null;
  }

  function buildModelSelect() {
    var provider = currentProvider();
    el.model.innerHTML = "";
    if (!provider) {
      updateNote();
      updateGenerateState();
      return;
    }
    provider.models.forEach(function (model) {
      var option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label + (modelUsable(model) ? "" : " - needs PUBLIC_BASE_URL");
      option.disabled = !modelUsable(model);
      el.model.appendChild(option);
    });
    var usable = provider.models.filter(modelUsable)[0];
    if (usable) el.model.value = usable.id;
    updateNote();
    updateGenerateState();
  }

  function currentModel() {
    var provider = currentProvider();
    if (!provider) return null;
    for (var i = 0; i < provider.models.length; i++) {
      if (provider.models[i].id === el.model.value) return provider.models[i];
    }
    return null;
  }

  function updateNote() {
    var provider = currentProvider();
    var model = currentModel();
    var parts = [];
    var warn = false;

    if (provider && provider.note) parts.push(provider.note);
    if (model && model.note) parts.push(model.label + ": " + model.note);
    if (provider && !providerUsable(provider)) {
      parts.push("Missing " + (provider.keyEnv || []).join(" or ") + " in .env, so this endpoint is disabled.");
      warn = true;
    }
    if (model && model.requiresPublicUrl && !state.defaults.hasPublicBaseUrl) {
      parts.push("Set PUBLIC_BASE_URL in .env to a tunnel pointing at this server, then restart.");
      warn = true;
    }
    if (model && model.supportsEndFrame === false) {
      parts.push("This model ignores the end anchor: the last in-between frame will not land on your keyframe.");
      warn = true;
    }

    el.providerNote.textContent = parts.join(" ");
    el.providerNote.className = "note" + (warn ? " warn" : "");

    if (model && model.defaults && model.defaults.duration) {
      var wanted = String(model.defaults.duration);
      for (var i = 0; i < el.duration.options.length; i++) {
        if (el.duration.options[i].value === wanted) el.duration.value = wanted;
      }
    }
  }

  function buildCountSelects() {
    var min = state.limits.MIN_IN_BETWEEN || 1;
    var max = state.limits.MAX_IN_BETWEEN || 10;
    [el.countA, el.countB].forEach(function (select) {
      select.innerHTML = "";
      for (var i = min; i <= max; i++) {
        var option = document.createElement("option");
        option.value = String(i);
        option.textContent = String(i);
        if (i === 3) option.selected = true;
        select.appendChild(option);
      }
    });
  }

  /* ----------------------------------------------------------- uploads */

  function initDrops() {
    var drops = document.querySelectorAll(".drop");
    Array.prototype.forEach.call(drops, function (drop) {
      var slot = drop.getAttribute("data-slot");
      var input = drop.querySelector("input[type=file]");

      input.addEventListener("change", function () {
        if (input.files && input.files[0]) readFile(slot, input.files[0]);
        input.value = "";
      });

      ["dragenter", "dragover"].forEach(function (name) {
        drop.addEventListener(name, function (event) {
          event.preventDefault();
          drop.classList.add("dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (name) {
        drop.addEventListener(name, function (event) {
          event.preventDefault();
          drop.classList.remove("dragover");
        });
      });
      drop.addEventListener("drop", function (event) {
        var files = event.dataTransfer && event.dataTransfer.files;
        if (files && files[0]) readFile(slot, files[0]);
      });
    });
  }

  function readFile(slot, file) {
    if (!/^image\//.test(file.type)) {
      notice("That file is not an image.", "error");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      notice("That image is larger than 40 MB.", "error");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      state.uploads[slot] = { name: file.name, dataUrl: dataUrl };
      var drop = document.querySelector('.drop[data-slot="' + slot + '"]');
      var thumb = drop.querySelector(".thumb");
      thumb.src = dataUrl;
      thumb.hidden = false;
      drop.classList.add("filled");
      notice("");
      updateGenerateState();
    };
    reader.onerror = function () { notice("Could not read " + file.name, "error"); };
    reader.readAsDataURL(file);
  }

  /* ---------------------------------------------------------- generate */

  function updateGenerateState() {
    var hasAll = Boolean(state.uploads.start && state.uploads.middle && state.uploads.end);
    var named = SCENE_RE.test(el.scene.value.trim());
    var model = currentModel();
    el.generate.disabled = state.busy || !hasAll || !named || !model;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.cancel.disabled = !busy;
    el.generate.textContent = busy ? "Generating..." : "Generate frames";
    updateGenerateState();
  }

  function generate() {
    var scene = el.scene.value.trim();
    if (!SCENE_RE.test(scene)) {
      notice("Scene name must start with a letter or digit and may only use letters, digits, dot, dash or underscore (max 64 characters).", "error");
      return;
    }
    if (!state.uploads.start || !state.uploads.middle || !state.uploads.end) {
      notice("Add all three anchor frames first.", "error");
      return;
    }
    if (!currentModel()) {
      notice("Pick an AI endpoint and model first.", "error");
      return;
    }

    var body = {
      scene: scene,
      prompt: el.prompt.value,
      negativePrompt: el.negative.value,
      provider: el.provider.value,
      model: el.model.value,
      inBetweenA: Number(el.countA.value),
      inBetweenB: Number(el.countB.value),
      duration: Number(el.duration.value),
      fps: Number(el.fps.value) || 12,
      numbering: el.numbering.value,
      overwrite: el.overwrite.checked,
      reuseVideos: el.reuse.checked,
      makePreview: el.preview.checked,
      start: state.uploads.start.dataUrl,
      middle: state.uploads.middle.dataUrl,
      end: state.uploads.end.dataUrl
    };

    try { localStorage.setItem("comicgen-provider", el.provider.value); } catch (err) {}

    el.log.innerHTML = "";
    clearResult();
    notice("");
    setBusy(true);

    fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    }).then(function (out) {
      if (out.status >= 400) throw new Error(out.data.error || "The request was rejected.");
      state.jobId = out.data.jobId;
      follow(out.data.jobId);
    }).catch(function (err) {
      setBusy(false);
      notice(err && err.message ? err.message : String(err), "error");
    });
  }

  function follow(jobId) {
    closeStream();
    var source = new EventSource("/api/jobs/" + encodeURIComponent(jobId) + "/events");
    state.stream = source;

    source.addEventListener("log", function (event) {
      appendLog(JSON.parse(event.data));
    });

    source.addEventListener("state", function (event) {
      applyState(JSON.parse(event.data));
    });

    source.addEventListener("done", function (event) {
      var result = JSON.parse(event.data);
      state.result = result;
      closeStream();
      setBusy(false);
      showResult(result);
      loadScenes();
      notice("Done. " + result.frames.length + " frames written to projects/" + result.dir, "ok");
    });

    source.addEventListener("failed", function (event) {
      var payload = JSON.parse(event.data);
      closeStream();
      setBusy(false);
      notice(payload.message || "Generation failed.", "error");
    });

    source.addEventListener("error", function () {
      if (state.stream === source && source.readyState === EventSource.CLOSED) {
        closeStream();
        setBusy(false);
      }
    });
  }

  function closeStream() {
    if (state.stream) {
      try { state.stream.close(); } catch (err) {}
      state.stream = null;
    }
  }

  function cancelJob() {
    if (!state.jobId) return;
    fetch("/api/jobs/" + encodeURIComponent(state.jobId) + "/cancel", { method: "POST" }).catch(function () {});
  }

  function appendLog(entry) {
    var line = text("div", "log-line log-" + (entry.level || "info"));
    var at = new Date(entry.at);
    var stamp = [
      String(at.getHours()).padStart(2, "0"),
      String(at.getMinutes()).padStart(2, "0"),
      String(at.getSeconds()).padStart(2, "0")
    ].join(":");
    line.appendChild(text("span", "log-time", stamp));
    line.appendChild(text("span", "log-msg", entry.message));
    el.log.appendChild(line);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function applyState(job) {
    el.barFill.style.width = (job.progress || 0) + "%";
    el.stage.textContent = job.stage || "idle";
  }

  /* ----------------------------------------------------------- results */

  function clearResult() {
    el.result.innerHTML = "";
    el.result.appendChild(text("p", "empty", "Generated frames will appear here."));
  }

  function showResult(result) {
    el.result.innerHTML = "";

    var strip = text("div", "strip");
    result.frames.forEach(function (frame) {
      var box = text("div", "frame" + (frame.role === "generated" ? "" : " anchor"));
      var img = document.createElement("img");
      img.src = frame.url;
      img.alt = frame.file;
      img.loading = "lazy";
      box.appendChild(img);
      box.appendChild(text("span", "tag", frame.file));
      box.title = frame.role + (frame.segment ? " (segment " + frame.segment + ")" : " (uploaded anchor)");
      strip.appendChild(box);
    });
    el.result.appendChild(strip);

    var previews = result.previews || {};
    if (previews.mp4) {
      var video = document.createElement("video");
      video.className = "preview-media";
      video.src = previews.mp4;
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      el.result.appendChild(video);
    } else if (previews.gif) {
      var gif = document.createElement("img");
      gif.className = "preview-media";
      gif.src = previews.gif;
      gif.alt = "preview";
      el.result.appendChild(gif);
    }

    var links = text("div", "links");
    links.appendChild(makeLink(result.manifestUrl, "manifest.json"));
    if (previews.mp4) links.appendChild(makeLink(previews.mp4, "preview.mp4"));
    if (previews.gif) links.appendChild(makeLink(previews.gif, "preview.gif"));
    el.result.appendChild(links);

    var summary = "Folder: projects/" + result.dir + " - " + result.frames.length + " frames at " +
      result.size.width + "x" + result.size.height + " (" +
      result.inBetweens.segmentA + " + " + result.inBetweens.segmentB + " generated).";
    el.result.appendChild(text("p", "empty", summary));
  }

  function makeLink(href, label) {
    var anchor = document.createElement("a");
    anchor.className = "btn btn-ghost btn-small";
    anchor.style.textDecoration = "none";
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = label;
    return anchor;
  }

  /* ------------------------------------------------------------ scenes */

  function loadScenes() {
    fetch("/api/scenes").then(function (res) { return res.json(); }).then(function (data) {
      var scenes = data.scenes || [];
      el.scenes.innerHTML = "";
      if (!scenes.length) {
        el.scenes.appendChild(text("p", "empty", "No scenes yet."));
        return;
      }
      scenes.forEach(function (scene) {
        var row = text("div", "scene-row");
        row.appendChild(text("span", "name", scene.scene));
        row.appendChild(text("span", "meta", (scene.frameCount ? scene.frameCount + " frames" : "no manifest") + (scene.provider ? " - " + scene.provider : "")));
        row.appendChild(makeLink("/api/files/scenes/" + encodeURIComponent(scene.scene) + "/preview.gif", "gif"));
        var remove = text("button", "btn btn-ghost btn-small btn-danger", "Delete");
        remove.type = "button";
        remove.addEventListener("click", function () {
          if (!window.confirm("Delete scene '" + scene.scene + "' and all of its frames?")) return;
          fetch("/api/scenes/" + encodeURIComponent(scene.scene), { method: "DELETE" }).then(loadScenes);
        });
        row.appendChild(remove);
        el.scenes.appendChild(row);
      });
    }).catch(function () {});
  }

  /* -------------------------------------------------------------- init */

  function cacheElements() {
    el.scene = byId("scene");
    el.prompt = byId("prompt");
    el.negative = byId("negative");
    el.provider = byId("provider");
    el.model = byId("model");
    el.providerNote = byId("provider-note");
    el.countA = byId("count-a");
    el.countB = byId("count-b");
    el.duration = byId("duration");
    el.fps = byId("fps");
    el.numbering = byId("numbering");
    el.overwrite = byId("overwrite");
    el.reuse = byId("reuse");
    el.preview = byId("preview");
    el.generate = byId("generate");
    el.cancel = byId("cancel");
    el.notice = byId("notice");
    el.stage = byId("stage");
    el.barFill = byId("bar-fill");
    el.log = byId("log");
    el.result = byId("result");
    el.scenes = byId("scenes");
    el.themeToggle = byId("theme-toggle");
    el.health = byId("health");
  }

  function init() {
    cacheElements();
    initTheme();
    initDrops();
    setBusy(false);

    el.provider.addEventListener("change", function () {
      buildModelSelect();
      try { localStorage.setItem("comicgen-provider", el.provider.value); } catch (err) {}
    });
    el.model.addEventListener("change", function () {
      updateNote();
      updateGenerateState();
    });
    el.scene.addEventListener("input", updateGenerateState);
    el.generate.addEventListener("click", generate);
    el.cancel.addEventListener("click", cancelJob);

    loadHealth();
    loadScenes();
    loadProviders()
      .then(function () { updateGenerateState(); })
      .catch(function (err) { notice("Could not load the provider list: " + err.message, "error"); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
