import { ensureDir, pathExists, writeJSON } from "fs-extra";
import { resolve } from "node:path";
import download from "nodejs-file-downloader";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { EOL } from "node:os";
import { downloadDir, workerNum } from "../config/config.json";
import { DownloadCoreMessage, SpiderQueue } from "../type";
import { errQueueToJson, getDateTimeString, getFileSize, logError } from "../utils";
import { headerOption as headers } from "../utils/config";
import cliProgress from "cli-progress";
import filenamify from "filenamify";

/**
 * 下载视频队列
 * @param videoQueue 下载队列
 * @param dir 下载目录
 */
export const downloadVideoQueue = async (videoQueue: SpiderQueue[], dir: string) => {
  if (isMainThread) {
    const progressBar = new cliProgress.MultiBar(
      {
        hideCursor: true,
        stopOnComplete: true,
        linewrap: true,
        forceRedraw: true,
        barsize: 60,
        autopadding: true,
        clearOnComplete: false,
        format:
          "整体进度: {bar} {percentage}% | {complete}/{total} | 成功:{success} 失败:{failed} 进行中:{running}",
      },
      cliProgress.Presets.shades_grey
    );
    let downloadRecord = 0;
    let failedRecord = 0;
    let activeRecord = 0;
    let logCount = 0;
    const overallProgress = progressBar.create(videoQueue.length, 0, {
      complete: 0,
      total: videoQueue.length,
      success: 0,
      failed: 0,
      running: 0,
    });
    const workerData = [];
    const len = Math.ceil(videoQueue.length / workerNum);
    for (let i = 0; i < workerNum; i++) workerData.push(videoQueue.slice(i * len, (i + 1) * len));
    const workers = workerData.map((data) => new Worker(__filename, { workerData: { videoQueue: data, dir } }));

    const promises = workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.on("message", (msg: DownloadCoreMessage) => {
            if (msg.type === "progress") {
              return;
            } else if (msg.type === "record" && msg.record) {
              downloadRecord++;
              overallProgress.update(downloadRecord + failedRecord, {
                complete: downloadRecord + failedRecord,
                total: videoQueue.length,
                success: downloadRecord,
                failed: failedRecord,
                running: activeRecord,
              });
            } else if (msg.type === "status") {
              if (msg.status === "start") activeRecord++;
              if (msg.status === "success") activeRecord = Math.max(activeRecord - 1, 0);
              if (msg.status === "failed") {
                activeRecord = Math.max(activeRecord - 1, 0);
                failedRecord++;
                overallProgress.update(downloadRecord + failedRecord, {
                  complete: downloadRecord + failedRecord,
                  total: videoQueue.length,
                  success: downloadRecord,
                  failed: failedRecord,
                  running: activeRecord,
                });
              }

              overallProgress.update(downloadRecord + failedRecord, {
                complete: downloadRecord + failedRecord,
                total: videoQueue.length,
                success: downloadRecord,
                failed: failedRecord,
                running: activeRecord,
              });
            } else if (msg.type === "log") {
              logCount++;
              progressBar.log(`[${logCount}] ${msg.level.toUpperCase()} ${msg.message}${EOL}`);
            } else if (msg.type === "done") resolve(msg.hasErr);
          });
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
          });
        })
    );

    const results = await Promise.allSettled(promises);

    progressBar.stop();
    console.log(
      "下载完成 任务结束 ===> 成功:",
      downloadRecord,
      "失败:",
      failedRecord,
      "总数:",
      videoQueue.length
    );
    return results.every((result) => result.status === "fulfilled" && result.value);
  } else {
    let hasErr = false;
    for await (const [index, item] of workerData.videoQueue.entries()) {
      try {
        // if (Array.isArray(item.url)) await downloadImageSingle(item, workerData.dir);
        // else await downloadVideoSingle(item, workerData.dir);
        parentPort.postMessage({ type: "status", status: "start", id: item.id });
        parentPort.postMessage({
          type: "log",
          level: "info",
          message: `开始下载 ${item.isImage ? "图集" : "视频"} ${item.id}（队列序号 ${index + 1}）`,
        });

        if (item.isImage) await downloadImageSingle(item, workerData.dir);
        else await downloadVideoSingle(item, workerData.dir);

        parentPort.postMessage({ type: "status", status: "success", id: item.id });
        parentPort.postMessage({
          type: "log",
          level: "info",
          message: `下载完成 ${item.id}`,
        });
      } catch (error) {
        hasErr = true;
        const errLogPath = resolve(process.cwd(), downloadDir, "logs");
        await logError(error, resolve(errLogPath, `${getDateTimeString()}.log`));
        await errQueueToJson(JSON.stringify(item.info), resolve(errLogPath, "errorQueue.json"));
        parentPort.postMessage({ type: "status", status: "failed", id: item.id });
        parentPort.postMessage({
          type: "log",
          level: "error",
          message: `下载失败 ${item.id}，错误日志已保存`,
        });
        continue;
      }
    }
    parentPort.postMessage({ type: "done", hasErr });
  }
};

/**
 * 下载核心
 * @param url 下载地址
 * @param directory 下载目录
 * @param fileName 下载文件名
 * @param option 下载选项
 * @returns
 */
const downloadCore = (url: string, directory: string, fileName: string, id: string, last: boolean) => {
  let totalSize = "0";

  return new download({
    url,
    directory,
    fileName,
    headers,
    maxAttempts: 3,
    skipExistingFileName: true,
    onResponse: (response) => {
      totalSize = getFileSize(response.headers["content-length"]);
      return true;
    },
    onProgress: (percentage) => {
      parentPort.postMessage({ type: "progress", message: { id, percentage, totalSize } });
    },
    onBeforeSave: (finalName) => {
      if (last) parentPort.postMessage({ type: "record", record: true });
      return finalName;
    },
  });
};

const saveMetaIfMissing = async (metaPath: string, info: any) => {
  const exists = await pathExists(metaPath);
  if (!exists) await writeJSON(metaPath, info, { spaces: 2 });
  return !exists;
};

const postRecordMessage = () => {
  if (!isMainThread && parentPort) parentPort.postMessage({ type: "record", record: true });
};

/**
 * 下载单个视频
 * @param item 下载项
 * @param dir 下载目录
 */
export const downloadVideoSingle = async (item: SpiderQueue, dir: string) => {
  if (!Array.isArray(item.url)) {
    const directory = resolve(process.cwd(), downloadDir, filenamify(dir));
    const fileName = `${item.id}-${filenamify(item.desc)}.mp4`;
    const metaName = `${item.id}-${filenamify(item.desc)}.json`;
    const videoPath = resolve(directory, fileName);
    const metaPath = resolve(directory, metaName);
    await ensureDir(directory).catch((error) => console.log("downloadVideoQueue: 下载目录创建失败"));

    const hasVideo = await pathExists(videoPath);
    const hasMeta = await pathExists(metaPath);

    if (hasVideo && hasMeta) {
      postRecordMessage();
      return;
    }

    if (!hasVideo) {
      let downloadHelper = downloadCore(item.url as string, directory, fileName, item.id, true);
      await downloadHelper.download();
    }

    const isMetaCreated = await saveMetaIfMissing(metaPath, item.info);
    if (hasVideo && isMetaCreated) postRecordMessage();
  } else {
    const directory = resolve(process.cwd(), downloadDir, filenamify(dir), `${item.id}-${filenamify(item.desc)}`);
    const metaPath = resolve(directory, "metadata.json");
    await ensureDir(directory).catch(() => console.log("downloadVideoQueue: 下载目录创建失败"));

    const missingVideos: { index: number; url: string }[] = [];
    for await (const [entriesIndex, urlItem] of (item.url as string[]).entries()) {
      const fileName = `${item.id}_${entriesIndex}.mp4`;
      const videoPath = resolve(directory, fileName);
      const hasVideo = await pathExists(videoPath);
      if (!hasVideo) missingVideos.push({ index: entriesIndex, url: urlItem });
    }
    const hasMeta = await pathExists(metaPath);

    if (missingVideos.length === 0 && hasMeta) {
      postRecordMessage();
      return;
    }

    for await (const [i, video] of missingVideos.entries()) {
      const fileName = `${item.id}_${video.index}.mp4`;
      const isLastMissingVideo = i === missingVideos.length - 1;
      let downloadHelper = downloadCore(video.url, directory, fileName, item.id, isLastMissingVideo);
      await downloadHelper.download();
    }

    const isMetaCreated = await saveMetaIfMissing(metaPath, item.info);
    if (missingVideos.length === 0 && isMetaCreated) postRecordMessage();
  }
}

/**
 * 下载单个图片
 * @param item 下载项
 * @param dir 下载目录
 */
export const downloadImageSingle = async (item: SpiderQueue, dir: string) => {
  const directory = resolve(process.cwd(), downloadDir, filenamify(dir), `${item.id}-${filenamify(item.desc)}`);
  const metaPath = resolve(directory, "metadata.json");
  const extNameRegex = /\jpg|jpeg|png|webp/i;
  await ensureDir(directory).catch(() => console.log("downloadVideoQueue: 下载目录创建失败"));

  const missingImages: { index: number; url: string; extName: string }[] = [];
  for await (const [entriesIndex, urlItem] of (item.url as string[]).entries()) {
    const extName = extNameRegex.exec(urlItem)[0];
    const fileName = `${item.id}_${entriesIndex}.${extName}`;
    const imagePath = resolve(directory, fileName);
    const hasImage = await pathExists(imagePath);
    if (!hasImage) missingImages.push({ index: entriesIndex, url: urlItem, extName });
  }
  const hasMeta = await pathExists(metaPath);

  if (missingImages.length === 0 && hasMeta) {
    postRecordMessage();
    return;
  }

  for await (const [i, image] of missingImages.entries()) {
    const fileName = `${item.id}_${image.index}.${image.extName}`;
    const isLastMissingImage = i === missingImages.length - 1;
    let downloadHelper = downloadCore(image.url, directory, fileName, item.id, isLastMissingImage);
    await downloadHelper.download();
  }
  const isMetaCreated = await saveMetaIfMissing(metaPath, item.info);
  if (missingImages.length === 0 && isMetaCreated) postRecordMessage();
};

if (!isMainThread) downloadVideoQueue([], "");
function fileURLToPath(url: string) {
  throw new Error("Function not implemented.");
}
