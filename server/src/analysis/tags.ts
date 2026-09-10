/**
 * 标签净化：过滤非算法能力维度的"噪声标签"。
 * 这些标签来自平台题库的来源/赛事实务维度，混入弱项画像会误导训练方向
 * （实测案例：洛谷「2026」「蓝桥杯省赛」、CF「*special」占据弱项 top8 的半数）。
 * 标签全集以真实库洛谷 117 个 tag 校准，避免误杀算法标签。
 *
 * 实现已移至 shared/src/index.ts（canonicalTag 同处），供客户端与服务端共用。
 * 此文件仅做 re-export，保持现有 import 路径（'./tags.ts'）不变。
 */
export { isNoiseTag, filterNoiseTags } from '../../../shared/src/index.ts';
