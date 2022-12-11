import { Telegraf, Context } from 'telegraf';
import { telegrafThrottler } from 'telegraf-throttler';
import config from './config';
import { v4 as v4uuid } from 'uuid';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import cluster from 'cluster';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import md5 from 'md5';
import asyncRetry from 'async-retry';

if (!config.sendVideo && !config.sendComparedImg && !config.sendSingleImg) {
    throw new Error('Set at leats one of "sendVideo"/"sendComparedImg"/"sendSingleImg" in your config to "true"');
}

let httpsAgent: HttpsProxyAgent | SocksProxyAgent | undefined = undefined;
if (config.httpsProxy) {
    httpsAgent = new HttpsProxyAgent(config.httpsProxy);
    httpsAgent.timeout = 30000;
} else if (config.socksProxy) {
    httpsAgent = new SocksProxyAgent(config.socksProxy);
    httpsAgent.timeout = 30000;
}

const signV1 = (obj: Record<string, unknown>) => {
    const str = JSON.stringify(obj);
    return md5(
        'https://h5.tu.qq.com' +
        (str.length + (encodeURIComponent(str).match(/%[89ABab]/g)?.length || 0)) +
        'HQ31X02e',
    );
};

const qqRequest = async (imgData: string) => {
    const obj = {
        busiId: 'ai_painting_anime_entry',
        extra: JSON.stringify({
            face_rects: [],
            version: 2,
            platform: 'web',
            data_report: {
                parent_trace_id: v4uuid(),
                root_channel: '',
                level: 0,
            },
        }),
        images: [imgData],
    };
    const sign = signV1(obj);

    let extra;
    try {
        extra = await asyncRetry(
            async (bail) => {
                const response = await axios.request({
                    httpsAgent,
                    method: 'POST',
                    url: 'https://ai.tu.qq.com/trpc.shadow_cv.ai_processor_cgi.AIProcessorCgi/Process',
                    data: obj,
                    headers: {
                        'Content-Type': 'application/json',
                        'Origin': 'https://h5.tu.qq.com',
                        'Referer': 'https://h5.tu.qq.com/',
                        'User-Agent':
                            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
                        'x-sign-value': sign,
                        'x-sign-version': 'v1',
                    },
                    timeout: 30000,
                });

                const data = response?.data as Record<string, unknown> | undefined;

                if (!data) {
                    throw new Error('No data');
                }

                if (data.msg === 'VOLUMN_LIMIT') {
                    throw new Error('QQ rate limit caught');
                }

                if (data.msg === 'IMG_ILLEGAL') {
                    bail(new Error('Couldn\'t pass the censorship. Try another photo.'));
                    return;
                }

                if (data.code === 1001) {
                    bail(new Error('Face not found. Try another photo.'));
                    return;
                }

                if (data.code === -2100) { // request image is invalid
                    bail(new Error('Try another photo.'));
                    return;
                }

                if (
                    data.code === 2119 || // user_ip_country
                    data.code === -2111 // AUTH_FAILED
                ) {
                    bail(new Error(config.blockedMessage || 'The Chinese website has blocked the bot, too bad 🤷‍♂️'));
                    return;
                }

                if (!data.extra) {
                    throw new Error('Got no data from QQ: ' + JSON.stringify(data));
                }

                return JSON.parse(data.extra as string);
            },
            {
                onRetry(e, attempt) {
                    console.error(`QQ file upload error caught (attempt #${attempt}): ${e.toString()}`);
                },
                retries: 100,
                factor: 1,
            },
        );
    } catch (e) {
        console.error(`QQ file upload error caught: ${(e as Error).toString()}`);
        throw new Error(`Unable to upload the photo: ${(e as Error).toString()}`);
    }

    return {
        videoUrl: extra.video_urls[0] as string,
        comparedImgUrl: extra.img_urls[1] as string,
        singleImgUrl: extra.img_urls[2] as string,
    };
};

const qqDownload = async (url: string): Promise<Buffer> => {
    let data;
    try {
        data = await asyncRetry(
            async () => {
                const response = await axios.request({
                    url,
                    timeout: 5000,
                    responseType: 'arraybuffer',
                });

                if (!response.data) {
                    throw new Error('No data');
                }

                return response.data;
            },
            {
                onRetry(e, attempt) {
                    console.error(`QQ file download error caught (attempt #${attempt}): ${e.toString()}`);
                },
                retries: 100,
                factor: 1,
            },
        );
    } catch (e) {
        console.error(`QQ file download error caught: ${(e as Error).toString()}`);
        throw new Error(`Unable to download media: ${(e as Error).toString()}`);
    }

    return data;
};

const userSessions: Array<UserSession> = [];

const cropImage = async (imgData: Buffer, type: 'COMPARED' | 'SINGLE'): Promise<Buffer> => {
    const img = sharp(imgData);
    const meta = await img.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;

    let cropLeft;
    let cropTop;
    let cropWidth;
    let cropHeight;
    if (type === 'COMPARED') {
        cropLeft = 0;
        cropTop = 0;
        cropWidth = width;
        cropHeight = height - (width > height ? 177 : 182);
    } else {
        cropLeft = (width > height ? 19 : 27);
        cropTop = (width > height ? 19 : 29);
        cropWidth = width - cropLeft - (width > height ? 22 : 30);
        cropHeight = height - cropTop - (width > height ? 202 : 213);
    }

    return img.extract({
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight,
    })
        .toBuffer();
};

const processUserSession = async ({ ctx, userId, photoId, replyMessageId }: UserSession) => {
    try {
        const url = await ctx.telegram.getFileLink(photoId);

        let telegramFileData;
        try {
            telegramFileData = await asyncRetry(
                async () => {
                    const response = await axios.request({
                        url: url.href,
                        timeout: 5000,
                        responseType: 'arraybuffer',
                    });

                    if (!response?.data) {
                        throw new Error('No data');
                    }

                    return response.data;
                },
                {
                    onRetry(e, attempt) {
                        console.error(`Telegram file download error caught (attempt #${attempt}): ${e.toString()}`);
                    },
                    retries: 100,
                    factor: 1,
                },
            );
        } catch (e) {
            console.error(`Telegram file download error caught: ${(e as Error).toString()}`);
            throw new Error('Couldn\'t load the photo, please try again');
        }

        if (config.keepFiles) {
            fs.writeFile(
                path.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_input.jpg'),
                telegramFileData,
            );
        }

        try {
            await ctx.reply('Photo has been received, please wait', {
                reply_to_message_id: replyMessageId,
            });
        } catch (e) {
            console.error('Unable to send "photo received" message for ' + userId, (e as Error).toString());
        }

        console.log('Uploading to QQ for ' + userId);
        const urls = await qqRequest(telegramFileData.toString('base64'));
        console.log('QQ responded successfully for ' + userId);

        console.log('Downloading from QQ for ' + userId);
        const [comparedImgData, singleImgData, videoData] = await Promise.all([
            (config.sendComparedImg ?? true) ? qqDownload(urls.comparedImgUrl).then((data) => cropImage(data, 'COMPARED')) : null,
            (config.sendSingleImg ?? false) ? qqDownload(urls.singleImgUrl).then((data) => cropImage(data, 'SINGLE')) : null,
            (config.sendVideo ?? true) ? qqDownload(urls.videoUrl) : null,
        ]);

        if (config.keepFiles && comparedImgData) {
            fs.writeFile(
                path.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_output_img.jpg'),
                comparedImgData,
            );
        }

        const sendMedia = async (fn: () => Promise<void>) => {
            return await asyncRetry(
                async (bail) => {
                    try {
                        await fn();
                    } catch (e) {
                        const msg = (e as Error).toString();

                        if (msg.includes('replied message not found')) {
                            bail(new Error('Photo has been deleted'));
                            return;
                        }

                        if (msg.includes('was blocked by the user')) {
                            bail(new Error('Bot was blocked by the user'));
                            return;
                        }

                        throw e;
                    }
                },
                {
                    onRetry(e, attempt) {
                        console.error(`Unable to send media for ${userId} (attempt #${attempt}): ${e.toString()}`);
                    },
                    retries: 100,
                    factor: 1,
                },
            );
        };

        const mediaPromises: Array<Promise<unknown>> = [];
        if (comparedImgData) {
            mediaPromises.push(sendMedia(async () => {
                await ctx.replyWithPhoto({
                    source: comparedImgData,
                }, {
                    caption: config.botUsername,
                    reply_to_message_id: replyMessageId,
                });
            }));
        }
        if (singleImgData) {
            mediaPromises.push(sendMedia(async () => {
                await ctx.replyWithPhoto({
                    source: singleImgData,
                }, {
                    caption: config.botUsername,
                    reply_to_message_id: replyMessageId,
                });
            }));
        }
        if (videoData) {
            mediaPromises.push(sendMedia(async () => {
                await ctx.replyWithVideo({
                    source: videoData,
                }, {
                    caption: config.botUsername,
                    reply_to_message_id: replyMessageId,
                });
            }));
        }
        const settled = await Promise.allSettled(mediaPromises);

        const errors = settled
            .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
            .map((item) => item.reason as Error);
        const sentCount = settled.filter((item) => item.status === 'fulfilled').length;
        const errorsMgs = errors.map(e => e.toString()).join(' ');

        if (errors.length) {
            console.error(`Unable to send media for ${userId} (${sentCount}/${mediaPromises.length}): ${errorsMgs}`);
        }

        if (sentCount) {
            console.log(`Files sent to ${userId} (${sentCount}/${mediaPromises.length})`);
        } else {
            throw new Error(`Unable to send media, please try again: ${errorsMgs}`);
        }

        if (config.byeMessage) {
            try {
                await ctx.reply(config.byeMessage, {
                    disable_web_page_preview: true,
                    parse_mode: 'MarkdownV2',
                });
            } catch (e) {
                console.error('Unable to send byeMessage for ' + userId, (e as Error).toString());
            }
        }
    } catch (e) {
        console.log('Error has occurred for ' + userId);
        console.error(e);

        try {
            await asyncRetry(
                async (bail) => {
                    try {
                        await ctx.reply('Some nasty error has occurred, please try again\n\n' + (e as Error).toString());
                    } catch (e) {
                        if ((e as Error).toString().includes('was blocked by the user')) {
                            bail(new Error('Bot was blocked by the user'));
                            return;
                        }

                        throw e;
                    }
                },
                {
                    onRetry(e, attempt) {
                        console.error(`Unable to send error message for ${userId} (attempt #${attempt}): ${e.toString()}`);
                    },
                    retries: 100,
                    factor: 1,
                },
            );
        } catch (e) {
            console.error(`Unable to send error message for ${userId}: ${(e as Error).toString()}`);
        }
    }

    const currentSessionIndex = userSessions.findIndex((session) => session.userId === userId);
    userSessions.splice(currentSessionIndex, 1);
    console.log('Sessions length decreased: ' + userSessions.length);
    if (shuttingDown) {
        tryToShutDown();
    }
};

const addUserSession = async (ctx: Context, userId: number, photoId: string, replyMessageId: number) => {
    const currentSession = (userSessions.find((session) => session.userId === userId));
    if (currentSession) {
        await ctx.reply('You are already in the queue, please wait', {
            reply_to_message_id: replyMessageId,
        });
        return;
    }

    const session = {
        ctx,
        userId,
        photoId,
        replyMessageId,
    };
    userSessions.push(session);
    console.log('Sessions length increased: ' + userSessions.length);

    await processUserSession(session);
};

let bot: Telegraf;

const startBot = () => {
    bot = new Telegraf(config.botToken);

    const throttler = telegrafThrottler();
    bot.use(throttler);

    bot.start((ctx) => {
        ctx.reply(config.helloMessage, {
            disable_web_page_preview: true,
            parse_mode: 'MarkdownV2',
        })
            .catch((e) => {
                console.error('Unable to send helloMessage for ' + ctx.update.message.from.id, (e as Error).toString());
            });
    });

    bot.on('photo', (ctx) => {
        const userId = ctx.update.message.from.id;
        console.log('Received photo from ' + userId);

        const photoId = [...ctx.update.message.photo].pop()?.file_id || '';
        addUserSession(ctx, userId, photoId, ctx.update.message.message_id).catch(e => e);
    });

    bot.catch((e) => {
        console.error('Bot error has occurred ', e);
    });

    bot.launch();
};

const stopBot = () => {
    try {
        bot?.stop();
    } catch (e) {
        //
    }
};

let shuttingDown = false;

let tryToShutDown: () => void;

if (cluster.isPrimary) {
    let hasWorker = false;

    tryToShutDown = (): void => {
        shuttingDown = true;
        if (!hasWorker) {
            process.exit();
        }
    };

    const addWorker = (): void => {
        if (!shuttingDown) {
            const worker = cluster.fork();
            console.log(`Worker #${worker.process.pid} started`);
            hasWorker = true;
        }
    };
    addWorker();

    cluster.on('exit', (worker, code, signal) => {
        hasWorker = false;

        console.warn(`Worker #${worker.process.pid} is dead`, 'code:', code, 'signal:', signal);

        if (shuttingDown) {
            tryToShutDown();
        } else {
            setTimeout(() => {
                addWorker();
            }, 100);
        }
    });
} else {
    startBot();

    tryToShutDown = () => {
        if (!shuttingDown) {
            stopBot();
        }
        shuttingDown = true;

        if (!userSessions.length) {
            process.exit();
        }
    };
}

process.on('SIGINT', () => tryToShutDown());
process.on('SIGTERM', () => tryToShutDown());

process.on('unhandledRejection', (promise, reason) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    tryToShutDown();
});
process.on('uncaughtException', (err, origin) => {
    console.error('Uncaught Exception:', err, 'origin:', origin);
    tryToShutDown();
});
