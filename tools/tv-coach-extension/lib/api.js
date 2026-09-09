/**
 * lib/api.js — le seul chemin du panneau vers l'Omen.
 *
 * Le content script n'appelle JAMAIS ``fetch`` lui-même (spec §10) : il envoie
 * un message ``{type: 'api', ...}`` au service worker, qui détient le token et
 * les ``host_permissions``. Ce module enveloppe cet aller-retour et sait
 * attendre un travail détaché (``{"job": id}`` puis ``GET /job/{id}``, plan
 * §1.2 et ``paper_router._job_or_sync``).
 *
 * Tout ce qui touche ``chrome.*`` passe par ``deps.send`` : sous ``node --test``
 * on injecte une fausse fonction, aucun objet ``chrome`` n'est requis.
 */
(function () {
  'use strict';

  var DEFAULT_JOB_INTERVAL_MS = 3000;   /* plan Task 13 : sondage 3 s */
  var DEFAULT_JOB_TIMEOUT_MS = 180000;  /* les jobs LLM tiennent 30 s à 2 min */

  /** Erreur d'appel : porte le code HTTP et le détail rendu par FastAPI. */
  function ApiError(message, status, detail) {
    var error = new Error(message);
    error.name = 'ApiError';
    error.status = status === undefined ? 0 : status;
    error.detail = detail === undefined ? '' : detail;
    return error;
  }

  /** Envoi par défaut : ``chrome.runtime.sendMessage`` en style callback. */
  function chromeSend(message) {
    return new Promise(function (resolve, reject) {
      var runtime = (typeof chrome !== 'undefined' && chrome) ? chrome.runtime : null;
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        reject(ApiError('service worker indisponible', 0, 'no-runtime'));
        return;
      }
      try {
        runtime.sendMessage(message, function (response) {
          var failure = runtime.lastError;
          if (failure) {
            reject(ApiError(failure.message || 'runtime', 0, 'runtime'));
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(ApiError(String((e && e.message) || e), 0, 'runtime'));
      }
    });
  }

  function buildQuery(query) {
    if (!query || typeof query !== 'object') { return ''; }
    var parts = [];
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i += 1) {
      var value = query[keys[i]];
      if (value === null || value === undefined || value === '') { continue; }
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(String(value)));
    }
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  /**
   * ``createApi({send})`` rend l'objet d'appel du panneau.
   * ``send(message) -> Promise<{ok, status, data, error}>``.
   */
  function createApi(deps) {
    var options = deps || {};
    var send = options.send || chromeSend;
    var jobIntervalMs = options.jobIntervalMs || DEFAULT_JOB_INTERVAL_MS;
    var jobTimeoutMs = options.jobTimeoutMs || DEFAULT_JOB_TIMEOUT_MS;
    var now = options.now || function () { return Date.now(); };
    var sleep = options.sleep || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };

    function request(path, config) {
      var conf = config || {};
      var message = {
        type: 'api',
        path: String(path || '') + buildQuery(conf.query),
        method: conf.method || 'GET',
        body: conf.body === undefined ? null : conf.body
      };
      return Promise.resolve(send(message)).then(function (response) {
        if (!response) {
          throw ApiError('aucune réponse du service worker', 0, 'no-response');
        }
        if (response.ok === false) {
          throw ApiError(response.error || 'appel refusé',
                         response.status || 0,
                         response.detail || response.error || '');
        }
        return response.data;
      });
    }

    function get(path, query) { return request(path, { method: 'GET', query: query }); }
    function post(path, body) { return request(path, { method: 'POST', body: body }); }
    function del(path) { return request(path, { method: 'DELETE' }); }

    /**
     * Relève d'un travail détaché : ``pending`` -> on repasse dans 3 s ;
     * ``done`` -> le résultat NU (comme si l'endpoint avait répondu en ligne) ;
     * ``error`` -> une ``ApiError`` porteuse du message du serveur.
     */
    function pollJob(jobId, config) {
      var conf = config || {};
      var interval = conf.intervalMs || jobIntervalMs;
      var deadline = now() + (conf.timeoutMs || jobTimeoutMs);
      function step() {
        return get('/job/' + encodeURIComponent(jobId)).then(function (data) {
          var status = data && data.status;
          if (status === 'done') { return data.result; }
          if (status === 'error') {
            throw ApiError(String((data && data.error) || 'travail en échec'),
                           (data && data.code) || 502, 'job-error');
          }
          if (now() >= deadline) {
            throw ApiError('travail trop long', 0, 'job-timeout');
          }
          if (typeof conf.onPending === 'function') { conf.onPending(jobId); }
          return sleep(interval).then(step);
        });
      }
      return step();
    }

    /**
     * ``job('/coach/ask', {question, lang})`` : POST puis relève. Une réponse
     * SANS clé ``job`` (mode ``?sync=1``) est rendue telle quelle.
     */
    function job(path, body, config) {
      return post(path, body).then(function (data) {
        if (data && data.job) { return pollJob(String(data.job), config); }
        return data;
      });
    }

    return {
      request: request,
      get: get,
      post: post,
      del: del,
      job: job,
      pollJob: pollJob
    };
  }

  var api = {
    createApi: createApi,
    ApiError: ApiError,
    buildQuery: buildQuery,
    DEFAULT_JOB_INTERVAL_MS: DEFAULT_JOB_INTERVAL_MS,
    DEFAULT_JOB_TIMEOUT_MS: DEFAULT_JOB_TIMEOUT_MS
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.api = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
