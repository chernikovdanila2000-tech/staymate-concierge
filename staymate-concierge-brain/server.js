const http = require('http');
const crypto = require('crypto');

const { runConciergeTurn } = require('./claude-client');
const {
  parseTelegramUpdate,
  sendTelegramMessage,
  setWebhook: setTelegramWebhook,
} = require('./telegram');
const {
  parseViberUpdate,
  sendViberMessage,
  setViberWebhook,
} = require('./viber');
const {
  safeEqual,
  verifyMessengerSignature,
  parseMessengerEvents,
  sendMessengerMessage,
} = require('./messenger');
const {
  verifyInstagramSignature,
  parseInstagramEvents,
  sendInstagramMessage,
} = require('./instagram');
const { serveLegalPage } = require('./legal-pages');
const {
  getTelegramToken,
  getViberToken,
  invalidateChannel,
} = require('./channels');
const { getHistory, saveHistory } = require('./conversations');
const {
  createSubscriptionInvoice,
  cancelRegularPayment,
} = require('./tools');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const WFP_MERCHANT_SECRET =
  process.env.WAYFORPAY_MERCHANT_SECRET ||
  'flk3409refn54t54t*FNJRET';

const API_BASE_URL =
  process.env.API_BASE_URL || 'http://localhost:3000';

const RESEND_API_KEY =
  process.env.RESEND_API_KEY || '';

const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ||
  'StayAI <noreply@stayai.online>';

const META_MESSENGER_PAGE_ACCESS_TOKEN =
  process.env.META_MESSENGER_PAGE_ACCESS_TOKEN || '';

const META_MESSENGER_APP_SECRET =
  process.env.META_MESSENGER_APP_SECRET || '';

const META_MESSENGER_VERIFY_TOKEN =
  process.env.META_MESSENGER_VERIFY_TOKEN || '';

const META_MESSENGER_PAGE_ID =
  process.env.META_MESSENGER_PAGE_ID || '';

const META_MESSENGER_PROPERTY_ID =
  process.env.META_MESSENGER_PROPERTY_ID || '';

const META_MESSENGER_PAGE_TO_PROPERTY_MAP =
  process.env.META_MESSENGER_PAGE_TO_PROPERTY_MAP || '';

const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || 'v24.0';

const PROPERTY_ID =
  process.env.PROPERTY_ID || '';

const META_INSTAGRAM_VERIFY_TOKEN =
  process.env.META_INSTAGRAM_VERIFY_TOKEN || '';

const META_INSTAGRAM_ACCESS_TOKEN =
  process.env.META_INSTAGRAM_ACCESS_TOKEN || '';

const META_INSTAGRAM_ACCOUNT_ID =
  process.env.META_INSTAGRAM_ACCOUNT_ID || '';

const META_INSTAGRAM_PROPERTY_ID =
  process.env.META_INSTAGRAM_PROPERTY_ID || '';

const PORT = process.env.PORT || 3000;

const propertyCache = new Map();
const PROPERTY_CACHE_TTL_MS = 60 * 1000;

const invalidPropertyCache = new Map();
const MESSENGER_INVALID_PROPERTY_TTL_MS = 5 * 60 * 1000;

let fallbackPropertyId = '';

let parsedMetaPagePropertyMap = {};

try {
  if (META_MESSENGER_PAGE_TO_PROPERTY_MAP) {
    const parsedMap =
      JSON.parse(META_MESSENGER_PAGE_TO_PROPERTY_MAP);

    if (
      parsedMap &&
      typeof parsedMap === 'object' &&
      !Array.isArray(parsedMap)
    ) {
      parsedMetaPagePropertyMap =
        Object.fromEntries(
          Object.entries(parsedMap).map(
            ([pageId, propertyId]) => [
              String(pageId),
              String(propertyId),
            ]
          )
        );
    }
  }
} catch (error) {
  console.error(
    '[messenger] Failed to parse page map:',
    error.message
  );
}

async function getProperty(propertyId) {
  const id = String(propertyId || '').trim();

  if (!id) return null;

  const cached = propertyCache.get(id);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.data;
  }

  const { data, error } =
    await supabase
      .from('properties')
      .select(
        'property_id, hotel_name, telegram_bot_token, subscription_status, trial_ends_at, subscription_active_until'
      )
      .eq('property_id', id)
      .maybeSingle();

  if (error) {
    console.error(
      '[getProperty] Supabase error:',
      error
    );

    return null;
  }

  if (!data) return null;

  propertyCache.set(id, {
    data,
    expiresAt:
      Date.now() + PROPERTY_CACHE_TTL_MS,
  });

  return data;
}

async function resolveMessengerPropertyId(
  entryPageId
) {
  const candidates = [];

  const addCandidate = (
    source,
    propertyId
  ) => {
    if (!propertyId) return;

    const id =
      String(propertyId).trim();

    if (!id) return;

    if (
      !candidates.some(
        item => item.propertyId === id
      )
    ) {
      candidates.push({
        source,
        propertyId: id,
      });
    }
  };

  if (
    entryPageId &&
    parsedMetaPagePropertyMap[
      String(entryPageId)
    ]
  ) {
    addCandidate(
      `page:${entryPageId}`,
      parsedMetaPagePropertyMap[
        String(entryPageId)
      ]
    );
  }

  addCandidate(
    'META_MESSENGER_PROPERTY_ID',
    META_MESSENGER_PROPERTY_ID
  );

  addCandidate(
    'PROPERTY_ID',
    PROPERTY_ID
  );

  for (const candidate of candidates) {
    const {
      propertyId,
      source,
    } = candidate;

    const invalidUntil =
      invalidPropertyCache.get(propertyId);

    if (
      invalidUntil &&
      invalidUntil > Date.now()
    ) {
      continue;
    }

    const property =
      await getProperty(propertyId);

    if (property) {
      return propertyId;
    }

    invalidPropertyCache.set(
      propertyId,
      Date.now() +
        MESSENGER_INVALID_PROPERTY_TTL_MS
    );

    console.error(
      `[messenger] Property "${propertyId}" from ${source} not found`
    );
  }

  if (
    fallbackPropertyId &&
    await getProperty(fallbackPropertyId)
  ) {
    return fallbackPropertyId;
  }

  const result =
    await supabase
      .from('properties')
      .select('property_id')
      .order('created_at', {
        ascending: true,
      })
      .limit(2);

  if (
    !result.error &&
    Array.isArray(result.data) &&
    result.data.length === 1
  ) {
    fallbackPropertyId =
      String(
        result.data[0].property_id || ''
      );

    return fallbackPropertyId;
  }

  if (
    !result.error &&
    Array.isArray(result.data) &&
    result.data.length > 0
  ) {
    fallbackPropertyId =
      String(
        result.data[0].property_id || ''
      );

    return fallbackPropertyId;
  }

  return '';
}

async function resolveInstagramConnection(
  instagramAccountId
) {
  const accountId =
    String(instagramAccountId || '').trim();

  if (!accountId) return null;

  const { data, error } =
    await supabase
      .from('channels')
      .select(
        'property_id, credentials, connected'
      )
      .eq(
        'channel_type',
        'instagram'
      )
      .eq(
        'connected',
        true
      )
      .contains(
        'credentials',
        {
          instagram_account_id:
            accountId,
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    console.error(
      '[instagram] Channel lookup error:',
      error
    );
  }

  if (
    data &&
    data.credentials &&
    data.credentials.access_token
  ) {
    let propertyId =
      String(data.property_id || '').trim();

    if (
      !propertyId ||
      !(await getProperty(propertyId))
    ) {
      propertyId =
        await resolveMessengerPropertyId('');
    }

    if (!propertyId) {
      return null;
    }

    return {
      propertyId,

      accessToken:
        String(
          data.credentials.access_token
        ),

      instagramAccountId:
        accountId,
    };
  }

  if (
    META_INSTAGRAM_ACCESS_TOKEN &&
    META_INSTAGRAM_ACCOUNT_ID &&
    String(
      META_INSTAGRAM_ACCOUNT_ID
    ) === accountId
  ) {
    let propertyId =
      String(
        META_INSTAGRAM_PROPERTY_ID ||
        META_MESSENGER_PROPERTY_ID ||
        PROPERTY_ID ||
        ''
      ).trim();

    if (
      !propertyId ||
      !(await getProperty(propertyId))
    ) {
      console.log(
        '[instagram] Configured property not found, using property fallback:',
        propertyId
      );

      propertyId =
        await resolveMessengerPropertyId('');
    }

    if (!propertyId) {
      console.error(
        '[instagram] No valid property resolved'
      );

      return null;
    }

    console.log(
      '[instagram] Resolved property:',
      propertyId
    );

    return {
      propertyId,

      accessToken:
        META_INSTAGRAM_ACCESS_TOKEN,

      instagramAccountId:
        accountId,
    };
  }

  return null;
}

function computeAccess(property) {
  const now = new Date();

  if (
    property.subscription_status ===
    'active'
  ) {
    if (
      !property.subscription_active_until ||
      new Date(
        property.subscription_active_until
      ) > now
    ) {
      return {
        allowed: true,
      };
    }

    return {
      allowed: false,
    };
  }

  if (
    property.trial_ends_at &&
    new Date(
      property.trial_ends_at
    ) > now
  ) {
    return {
      allowed: true,
    };
  }

  return {
    allowed: false,
  };
}

const PAUSED_MESSAGE =
  'Вибачте, наразі цей чат тимчасово недоступний. Будь ласка, зверніться до готелю напряму або спробуйте пізніше.';

function sendJson(
  res,
  status,
  payload,
  extraHeaders
) {
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type':
          'application/json; charset=utf-8',
      },
      extraHeaders || {}
    )
  );

  res.end(
    JSON.stringify(payload)
  );
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = '';

      req.on(
        'data',
        chunk => {
          body += chunk;
        }
      );

      req.on(
        'end',
        () => resolve(body)
      );

      req.on(
        'error',
        reject
      );
    }
  );
}

async function sendSignInNotification(
  email
) {
  if (
    !RESEND_API_KEY ||
    !email
  ) {
    return;
  }

  const html = `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17181b">
  <h2>StayAI</h2>
  <h3>Новий вхід в акаунт</h3>
  <p>Хтось щойно увійшов у ваш акаунт StayAI (${email}).</p>
  <p>Якщо це були ви — нічого робити не потрібно. Якщо ні — негайно змініть пароль.</p>
</div>`;

  try {
    const response =
      await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',

          headers: {
            Authorization:
              `Bearer ${RESEND_API_KEY}`,

            'Content-Type':
              'application/json',
          },

          body:
            JSON.stringify({
              from:
                RESEND_FROM_EMAIL,

              to: [email],

              subject:
                'Новий вхід в акаунт — StayAI',

              html,
            }),
        }
      );

    if (!response.ok) {
      console.error(
        '[signin-email]',
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      '[signin-email]',
      error.message
    );
  }
}

function wfpAcceptResponse(
  orderReference
) {
  const time =
    Math.floor(
      Date.now() / 1000
    );

  const signature =
    crypto
      .createHmac(
        'md5',
        WFP_MERCHANT_SECRET
      )
      .update(
        `${orderReference};accept;${time}`
      )
      .digest('hex');

  return {
    orderReference,
    status: 'accept',
    time,
    signature,
  };
}

const server =
  http.createServer(
    (req, res) => {
      const requestUrl =
        new URL(
          req.url,
          'http://localhost'
        );

      if (
        req.method === 'GET' &&
        serveLegalPage(
          requestUrl.pathname,
          res
        )
      ) {
        return;
      }

      // =========================
      // MESSENGER VERIFY
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/messenger' &&
        req.method === 'GET'
      ) {
        const mode =
          requestUrl.searchParams.get(
            'hub.mode'
          );

        const token =
          requestUrl.searchParams.get(
            'hub.verify_token'
          );

        const challenge =
          requestUrl.searchParams.get(
            'hub.challenge'
          );

        if (
          mode === 'subscribe' &&
          challenge &&
          safeEqual(
            token,
            META_MESSENGER_VERIFY_TOKEN
          )
        ) {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/plain; charset=utf-8',
            }
          );

          return res.end(
            challenge
          );
        }

        return sendJson(
          res,
          403,
          {
            error:
              'Webhook verification failed.',
          }
        );
      }

      // =========================
      // MESSENGER MESSAGE
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/messenger' &&
        req.method === 'POST'
      ) {
        readBody(req)
          .then(rawBody => {
            if (
              !verifyMessengerSignature(
                rawBody,
                req.headers[
                  'x-hub-signature-256'
                ],
                META_MESSENGER_APP_SECRET
              )
            ) {
              return sendJson(
                res,
                401,
                {
                  error:
                    'Invalid webhook signature.',
                }
              );
            }

            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Invalid JSON.',
                }
              );
            }

            const events =
              parseMessengerEvents(
                payload,
                META_MESSENGER_PAGE_ID
              );

            sendJson(
              res,
              200,
              {
                ok: true,
              }
            );

            setImmediate(
              async () => {
                if (
                  !META_MESSENGER_PAGE_ACCESS_TOKEN
                ) {
                  console.error(
                    '[messenger] Missing access token'
                  );

                  return;
                }

                const pageId =
                  Array.isArray(
                    payload.entry
                  ) &&
                  payload.entry[0]
                    ? payload
                        .entry[0]
                        .id
                    : '';

                const propertyId =
                  await resolveMessengerPropertyId(
                    pageId
                  );

                if (!propertyId) {
                  console.error(
                    '[messenger] Property not resolved'
                  );

                  return;
                }

                const property =
                  await getProperty(
                    propertyId
                  );

                if (!property) {
                  return;
                }

                for (
                  const event of events
                ) {
                  try {
                    const history =
                      await getHistory(
                        propertyId,
                        'messenger',
                        event.senderId
                      );

                    history.push({
                      role: 'user',
                      content:
                        event.text,
                    });

                    const {
                      replyText,
                      updatedHistory,
                    } =
                      await runConciergeTurn(
                        history,
                        {
                          propertyId,
                          propertyName:
                            property.hotel_name,
                        }
                      );

                    await saveHistory(
                      propertyId,
                      'messenger',
                      event.senderId,
                      updatedHistory
                    );

                    await sendMessengerMessage(
                      META_MESSENGER_PAGE_ACCESS_TOKEN,
                      event.senderId,
                      replyText,
                      META_GRAPH_VERSION
                    );
                  } catch (error) {
                    console.error(
                      '[messenger]',
                      error.message
                    );
                  }
                }
              }
            );
          })
          .catch(
            error =>
              sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              )
          );

        return;
      }

      // =========================
      // INSTAGRAM VERIFY
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/instagram' &&
        req.method === 'GET'
      ) {
        const mode =
          requestUrl.searchParams.get(
            'hub.mode'
          );

        const token =
          requestUrl.searchParams.get(
            'hub.verify_token'
          );

        const challenge =
          requestUrl.searchParams.get(
            'hub.challenge'
          );

        if (
          mode === 'subscribe' &&
          challenge &&
          safeEqual(
            token,
            META_INSTAGRAM_VERIFY_TOKEN
          )
        ) {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/plain; charset=utf-8',
            }
          );

          return res.end(
            challenge
          );
        }

        return sendJson(
          res,
          403,
          {
            error:
              'Instagram webhook verification failed.',
          }
        );
      }

      // =========================
      // INSTAGRAM MESSAGE
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/instagram' &&
        req.method === 'POST'
      ) {
        readBody(req)
          .then(rawBody => {
            if (
              !verifyInstagramSignature(
                rawBody,
                req.headers[
                  'x-hub-signature-256'
                ],
                META_MESSENGER_APP_SECRET
              )
            ) {
              return sendJson(
                res,
                401,
                {
                  error:
                    'Invalid Instagram signature.',
                }
              );
            }

            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Invalid JSON.',
                }
              );
            }

            console.log(
              '[instagram] PAYLOAD:',
              rawBody
            );

            const events =
              parseInstagramEvents(
                payload
              );

            const accountId =
              Array.isArray(
                payload.entry
              ) &&
              payload.entry[0]
                ? String(
                    payload.entry[0]
                      .id || ''
                  )
                : '';

            console.log(
              '[instagram] PARSED:',
              {
                accountId,
                eventsCount:
                  events.length,
                events,
              }
            );

            sendJson(
              res,
              200,
              {
                ok: true,
              }
            );

            if (
              !accountId ||
              events.length === 0
            ) {
              console.error(
                '[instagram] Nothing to process:',
                {
                  accountId,
                  eventsCount:
                    events.length,
                }
              );

              return;
            }

            setImmediate(
              async () => {
                try {
                  console.log(
                    '[instagram] BEFORE CONNECTION'
                  );

                  const connection =
                    await resolveInstagramConnection(
                      accountId
                    );

                  console.log(
                    '[instagram] CONNECTION:',
                    {
                      found:
                        !!connection,

                      propertyId:
                        connection
                          ? connection.propertyId
                          : null,

                      instagramAccountId:
                        connection
                          ? connection.instagramAccountId
                          : null,
                    }
                  );

                  if (!connection) {
                    console.error(
                      `[instagram] No channel for ${accountId}`
                    );

                    return;
                  }

                  console.log(
                    '[instagram] BEFORE PROPERTY:',
                    connection.propertyId
                  );

                  const property =
                    await getProperty(
                      connection.propertyId
                    );

                  console.log(
                    '[instagram] PROPERTY:',
                    {
                      found:
                        !!property,

                      hotelName:
                        property
                          ? property.hotel_name
                          : null,

                      subscriptionStatus:
                        property
                          ? property.subscription_status
                          : null,

                      trialEndsAt:
                        property
                          ? property.trial_ends_at
                          : null,

                      subscriptionActiveUntil:
                        property
                          ? property.subscription_active_until
                          : null,
                    }
                  );

                  if (!property) {
                    console.error(
                      '[instagram] Property not found:',
                      connection.propertyId
                    );

                    return;
                  }

                  const access =
                    computeAccess(
                      property
                    );

                  console.log(
                    '[instagram] ACCESS:',
                    access
                  );

                  for (
                    const event of events
                  ) {
                    try {
                      console.log(
                        '[instagram] EVENT START:',
                        {
                          senderId:
                            event.senderId,

                          text:
                            event.text,
                        }
                      );

                      if (
                        !access.allowed
                      ) {
                        console.log(
                          '[instagram] BEFORE PAUSED SEND'
                        );

                        await sendInstagramMessage(
                          connection.accessToken,
                          connection.instagramAccountId,
                          event.senderId,
                          PAUSED_MESSAGE,
                          META_GRAPH_VERSION
                        );

                        console.log(
                          '[instagram] AFTER PAUSED SEND'
                        );

                        continue;
                      }

                      console.log(
                        '[instagram] BEFORE HISTORY'
                      );

                      const history =
                        await getHistory(
                          connection.propertyId,
                          'instagram',
                          event.senderId
                        );

                      console.log(
                        '[instagram] HISTORY LOADED:',
                        {
                          length:
                            Array.isArray(
                              history
                            )
                              ? history.length
                              : null,
                        }
                      );

                      history.push({
                        role: 'user',
                        content:
                          event.text,
                      });

                      console.log(
                        '[instagram] BEFORE AI'
                      );

                      const {
                        replyText,
                        updatedHistory,
                      } =
                        await runConciergeTurn(
                          history,
                          {
                            propertyId:
                              connection.propertyId,

                            propertyName:
                              property.hotel_name,
                          }
                        );

                      console.log(
                        '[instagram] AFTER AI:',
                        {
                          replyLength:
                            String(
                              replyText || ''
                            ).length,

                          historyLength:
                            Array.isArray(
                              updatedHistory
                            )
                              ? updatedHistory.length
                              : null,
                        }
                      );

                      console.log(
                        '[instagram] BEFORE SAVE HISTORY'
                      );

                      await saveHistory(
                        connection.propertyId,
                        'instagram',
                        event.senderId,
                        updatedHistory
                      );

                      console.log(
                        '[instagram] AFTER SAVE HISTORY'
                      );

                      console.log(
                        '[instagram] BEFORE SEND'
                      );

                      await sendInstagramMessage(
                        connection.accessToken,
                        connection.instagramAccountId,
                        event.senderId,
                        replyText,
                        META_GRAPH_VERSION
                      );

                      console.log(
                        '[instagram] AFTER SEND'
                      );
                    } catch (
                      error
                    ) {
                      console.error(
                        '[instagram] EVENT ERROR:',
                        error &&
                        error.stack
                          ? error.stack
                          : error
                      );
                    }
                  }
                } catch (error) {
                  console.error(
                    '[instagram] PROCESS ERROR:',
                    error &&
                    error.stack
                      ? error.stack
                      : error
                  );
                }
              }
            );
          })
          .catch(
            error => {
              console.error(
                '[instagram] WEBHOOK ERROR:',
                error &&
                error.stack
                  ? error.stack
                  : error
              );

              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              );
            }
          );

        return;
      }

      // =========================
      // CORS
      // =========================

      if (
        req.method === 'OPTIONS' &&
        req.url.startsWith(
          '/webhook/website/'
        )
      ) {
        res.writeHead(
          204,
          {
            'Access-Control-Allow-Origin':
              '*',

            'Access-Control-Allow-Methods':
              'POST, OPTIONS',

            'Access-Control-Allow-Headers':
              'Content-Type',
          }
        );

        return res.end();
      }

      if (
        req.method === 'OPTIONS' &&
        [
          '/api/create-subscription-invoice',
          '/api/connect-channel',
          '/api/notify-signin',
          '/api/create-trial-invoice',
          '/api/cancel-auto-renew',
        ].includes(req.url)
      ) {
        res.writeHead(
          204,
          {
            'Access-Control-Allow-Origin':
              '*',

            'Access-Control-Allow-Methods':
              'POST, OPTIONS',

            'Access-Control-Allow-Headers':
              'Content-Type',
          }
        );

        return res.end();
      }

      // =========================
      // TEST CHAT
      // =========================

      if (
        req.method === 'POST' &&
        req.url === '/chat'
      ) {
        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                }
              );
            }

            const {
              userId,
              message,
              propertyId,
            } = parsed;

            if (
              !userId ||
              !message ||
              !propertyId
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні userId, message, propertyId.',
                }
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                }
              );
            }

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              return sendJson(
                res,
                200,
                {
                  reply:
                    PAUSED_MESSAGE,
                }
              );
            }

            const history =
              await getHistory(
                propertyId,
                'test',
                userId
              );

            history.push({
              role: 'user',
              content: message,
            });

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                  }
                );

              await saveHistory(
                propertyId,
                'test',
                userId,
                updatedHistory
              );

              return sendJson(
                res,
                200,
                {
                  reply:
                    replyText,
                }
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              );
            }
          }
        );

        return;
      }

      // =========================
      // TELEGRAM
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/telegram/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/telegram/'
                .length
            )
          );

        readBody(req).then(
          async body => {
            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              '{"ok":true}'
            );

            let update;

            try {
              update =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return;
            }

            const parsed =
              parseTelegramUpdate(
                update
              );

            if (!parsed) return;

            const property =
              await getProperty(
                propertyId
              );

            if (!property) return;

            const botToken =
              await getTelegramToken(
                propertyId,
                property
              );

            if (!botToken) return;

            const {
              chatId,
              text,
            } = parsed;

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              try {
                await sendTelegramMessage(
                  botToken,
                  chatId,
                  PAUSED_MESSAGE
                );
              } catch {}

              return;
            }

            const history =
              await getHistory(
                propertyId,
                'telegram',
                chatId
              );

            history.push({
              role: 'user',
              content: text,
            });

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                  }
                );

              await saveHistory(
                propertyId,
                'telegram',
                chatId,
                updatedHistory
              );

              await sendTelegramMessage(
                botToken,
                chatId,
                replyText
              );
            } catch (error) {
              console.error(
                '[telegram]',
                error.message
              );
            }
          }
        );

        return;
      }

      // =========================
      // VIBER
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/viber/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/viber/'
                .length
            )
          );

        readBody(req).then(
          async body => {
            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end('{}');

            let update;

            try {
              update =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return;
            }

            if (
              update.event !==
              'message'
            ) {
              return;
            }

            const parsed =
              parseViberUpdate(
                update
              );

            if (!parsed) return;

            const property =
              await getProperty(
                propertyId
              );

            if (!property) return;

            const viberToken =
              await getViberToken(
                propertyId
              );

            if (!viberToken) return;

            const {
              chatId,
              text,
            } = parsed;

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              try {
                await sendViberMessage(
                  viberToken,
                  chatId,
                  PAUSED_MESSAGE,
                  property.hotel_name
                );
              } catch {}

              return;
            }

            const history =
              await getHistory(
                propertyId,
                'viber',
                chatId
              );

            history.push({
              role: 'user',
              content: text,
            });

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                  }
                );

              await saveHistory(
                propertyId,
                'viber',
                chatId,
                updatedHistory
              );

              await sendViberMessage(
                viberToken,
                chatId,
                replyText,
                property.hotel_name
              );
            } catch (error) {
              console.error(
                '[viber]',
                error.message
              );
            }
          }
        );

        return;
      }

      // =========================
      // WEBSITE
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/website/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/website/'
                .length
            )
          );

        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              sessionId,
              message,
            } = parsed;

            if (
              !sessionId ||
              !message
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні sessionId і message.',
                },
                corsHeaders
              );
            }

            if (
              String(message).length >
              2000
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Повідомлення занадто довге.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              return sendJson(
                res,
                200,
                {
                  reply:
                    PAUSED_MESSAGE,
                },
                corsHeaders
              );
            }

            const history =
              await getHistory(
                propertyId,
                'website',
                sessionId
              );

            history.push({
              role: 'user',
              content:
                String(message),
            });

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                  }
                );

              await saveHistory(
                propertyId,
                'website',
                sessionId,
                updatedHistory
              );

              return sendJson(
                res,
                200,
                {
                  reply:
                    replyText,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // WAYFORPAY BOOKING
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/webhook/wayforpay'
      ) {
        readBody(req).then(
          async rawBody => {
            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody
                );
            } catch {
              res.writeHead(400);
              return res.end();
            }

            const {
              orderReference,
              transactionStatus,
            } = payload;

            if (
              orderReference &&
              transactionStatus ===
                'Approved'
            ) {
              const { error } =
                await supabase
                  .from('bookings')
                  .update({
                    status:
                      'paid',
                  })
                  .eq(
                    'booking_id',
                    orderReference
                  );

              if (error) {
                console.error(
                  '[wayforpay booking]',
                  error
                );
              }
            }

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              JSON.stringify(
                wfpAcceptResponse(
                  orderReference
                )
              )
            );
          }
        );

        return;
      }

      // =========================
      // WAYFORPAY SUBSCRIPTION
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/webhook/wayforpay-subscription'
      ) {
        readBody(req).then(
          async rawBody => {
            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody
                );
            } catch {
              res.writeHead(400);
              return res.end();
            }

            const {
              orderReference,
              transactionStatus,
            } = payload;

            if (
              orderReference &&
              transactionStatus ===
                'Approved'
            ) {
              const {
                data: order,
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .select(
                    'property_id, plan, is_trial_card'
                  )
                  .eq(
                    'order_id',
                    orderReference
                  )
                  .maybeSingle();

              if (
                !error &&
                order
              ) {
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .update({
                    status:
                      'paid',
                  })
                  .eq(
                    'order_id',
                    orderReference
                  );

                if (
                  order.is_trial_card
                ) {
                  const {
                    data: prop,
                  } =
                    await supabase
                      .from(
                        'properties'
                      )
                      .select(
                        'trial_ends_at'
                      )
                      .eq(
                        'property_id',
                        order.property_id
                      )
                      .maybeSingle();

                  const trialActive =
                    prop &&
                    prop.trial_ends_at &&
                    new Date(
                      prop.trial_ends_at
                    ) >
                      new Date();

                  const update = {
                    auto_renew: true,
                    last_auto_charge_failed:
                      false,
                  };

                  if (!trialActive) {
                    update.subscription_status =
                      'active';

                    update.subscription_plan =
                      order.plan;

                    update.subscription_active_until =
                      new Date(
                        Date.now() +
                          31 *
                            24 *
                            60 *
                            60 *
                            1000
                      ).toISOString();
                  }

                  await supabase
                    .from('properties')
                    .update(update)
                    .eq(
                      'property_id',
                      order.property_id
                    );
                } else {
                  await supabase
                    .from('properties')
                    .update({
                      subscription_status:
                        'active',

                      subscription_plan:
                        order.plan,

                      subscription_active_until:
                        new Date(
                          Date.now() +
                            31 *
                              24 *
                              60 *
                              60 *
                              1000
                        ).toISOString(),
                    })
                    .eq(
                      'property_id',
                      order.property_id
                    );
                }

                propertyCache.delete(
                  order.property_id
                );
              }
            }

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              JSON.stringify(
                wfpAcceptResponse(
                  orderReference
                )
              )
            );
          }
        );

        return;
      }

      // =========================
      // CREATE SUBSCRIPTION
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/create-subscription-invoice'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              plan,
            } = parsed;

            if (
              !propertyId ||
              !plan
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні propertyId і plan.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            const orderId =
              'SUB' +
              Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase();

            try {
              const {
                invoiceUrl,
                priceEur,
              } =
                await createSubscriptionInvoice(
                  {
                    orderId,
                    plan,
                    propertyName:
                      property.hotel_name,
                  }
                );

              const {
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .insert({
                    order_id:
                      orderId,

                    property_id:
                      propertyId,

                    plan,

                    status:
                      'pending',

                    amount_eur:
                      priceEur,
                  });

              if (error) {
                return sendJson(
                  res,
                  500,
                  {
                    error:
                      'Не вдалося створити замовлення.',
                  },
                  corsHeaders
                );
              }

              return sendJson(
                res,
                200,
                {
                  invoiceUrl,
                  orderId,
                  priceEur,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // CREATE TRIAL
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/create-trial-invoice'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              plan,
            } = parsed;

            if (
              !propertyId ||
              !plan
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні propertyId і plan.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (
              !property ||
              !property.trial_ends_at
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Немає активного trial.',
                },
                corsHeaders
              );
            }

            const orderId =
              'TRL' +
              Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase();

            const dateBegin =
              Math.floor(
                new Date(
                  property.trial_ends_at
                ).getTime() /
                  1000
              );

            try {
              const {
                invoiceUrl,
                priceEur,
              } =
                await createSubscriptionInvoice(
                  {
                    orderId,
                    plan,
                    propertyName:
                      property.hotel_name,

                    autoRenewDateBegin:
                      dateBegin,
                  }
                );

              const {
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .insert({
                    order_id:
                      orderId,

                    property_id:
                      propertyId,

                    plan,

                    status:
                      'pending',

                    amount_eur:
                      priceEur,

                    is_trial_card:
                      true,
                  });

              if (error) {
                return sendJson(
                  res,
                  500,
                  {
                    error:
                      'Не вдалося створити trial.',
                  },
                  corsHeaders
                );
              }

              await supabase
                .from('properties')
                .update({
                  regular_payment_reference:
                    orderId,
                })
                .eq(
                  'property_id',
                  propertyId
                );

              propertyCache.delete(
                propertyId
              );

              return sendJson(
                res,
                200,
                {
                  invoiceUrl,
                  orderId,
                  priceEur,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // CANCEL AUTO RENEW
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/cancel-auto-renew'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
            } = parsed;

            if (!propertyId) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібен propertyId.',
                },
                corsHeaders
              );
            }

            const {
              data: property,
            } =
              await supabase
                .from('properties')
                .select(
                  'regular_payment_reference'
                )
                .eq(
                  'property_id',
                  propertyId
                )
                .maybeSingle();

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            const {
              error,
            } =
              await supabase
                .from('properties')
                .update({
                  auto_renew:
                    false,

                  subscription_cancelled_at:
                    new Date().toISOString(),
                })
                .eq(
                  'property_id',
                  propertyId
                );

            if (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    'Не вдалося скасувати.',
                },
                corsHeaders
              );
            }

            propertyCache.delete(
              propertyId
            );

            let wfpResult = {
              ok: false,
              skipped: true,
            };

            if (
              property.regular_payment_reference
            ) {
              wfpResult =
                await cancelRegularPayment(
                  property.regular_payment_reference
                );
            }

            return sendJson(
              res,
              200,
              {
                ok: true,

                wayforpayConfirmed:
                  !!wfpResult.ok,
              },
              corsHeaders
            );
          }
        );

        return;
      }

      // =========================
      // LOGIN EMAIL
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/notify-signin'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            if (!parsed.email) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібен email.',
                },
                corsHeaders
              );
            }

            sendSignInNotification(
              parsed.email
            ).catch(() => {});

            return sendJson(
              res,
              200,
              {
                ok: true,
              },
              corsHeaders
            );
          }
        );

        return;
      }

      // =========================
      // CONNECT TELEGRAM / VIBER
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/connect-channel'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              channelType,
              credentials,
            } = parsed;

            if (
              !propertyId ||
              !channelType ||
              !credentials ||
              !credentials.bot_token
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні propertyId, channelType, credentials.bot_token.',
                },
                corsHeaders
              );
            }

            if (
              channelType !==
                'telegram' &&
              channelType !==
                'viber'
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Цей канал підключається інакше.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            try {
              if (
                channelType ===
                'telegram'
              ) {
                const result =
                  await setTelegramWebhook(
                    credentials.bot_token,
                    `${API_BASE_URL}/webhook/telegram/${propertyId}`
                  );

                if (!result.ok) {
                  throw new Error(
                    result.description ||
                      'Telegram error'
                  );
                }
              } else {
                const result =
                  await setViberWebhook(
                    credentials.bot_token,
                    `${API_BASE_URL}/webhook/viber/${propertyId}`
                  );

                if (
                  result.status !==
                  0
                ) {
                  throw new Error(
                    result.status_message ||
                      'Viber error'
                  );
                }
              }
            } catch (error) {
              return sendJson(
                res,
                400,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }

            const {
              error,
            } =
              await supabase
                .from('channels')
                .upsert(
                  {
                    property_id:
                      propertyId,

                    channel_type:
                      channelType,

                    credentials,

                    connected:
                      true,

                    connected_at:
                      new Date().toISOString(),
                  },
                  {
                    onConflict:
                      'property_id,channel_type',
                  }
                );

            if (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    'Не вдалося зберегти канал.',
                },
                corsHeaders
              );
            }

            invalidateChannel(
              propertyId,
              channelType
            );

            return sendJson(
              res,
              200,
              {
                ok: true,
              },
              corsHeaders
            );
          }
        );

        return;
      }

      if (
        req.method === 'GET' &&
        req.url === '/health'
      ) {
        return sendJson(
          res,
          200,
          {
            ok: true,
          }
        );
      }

      return sendJson(
        res,
        404,
        {
          error:
            'Not found',
        }
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `StayAI concierge server running on http://localhost:${PORT}`
    );

    console.log(
      '[messenger] Configured:',
      {
        pageId:
          META_MESSENGER_PAGE_ID ||
          'not_set',

        propertyId:
          META_MESSENGER_PROPERTY_ID ||
          'not_set',
      }
    );

    console.log(
      '[instagram] Configured:',
      {
        accountId:
          META_INSTAGRAM_ACCOUNT_ID ||
          'not_set',

        propertyId:
          META_INSTAGRAM_PROPERTY_ID ||
          'not_set',

        hasAccessToken:
          !!META_INSTAGRAM_ACCESS_TOKEN,

        hasVerifyToken:
          !!META_INSTAGRAM_VERIFY_TOKEN,
      }
    );
  }
);
