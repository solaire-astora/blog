/**
 * 设计程式 —— 索拉尔的主页
 *
 * 参照 Karl Gerstner《Designing Programmes》(1964)：不设计版面，设计一套程式。
 * 定一条规则 + 一组参数，版面是内容代入规则后被算出来的结果。
 *
 * 全站只有一条规则：
 *
 *     一个圆 = 一年，360° = 12 个月
 *     angle = (month - 1) × 30° + (day / 30) × 30°
 *
 * 每篇文章的发表日期唯一映射到 [0, 360) 上的一个角度。页面上每一枚环、
 * 每一根 1px 刻针的角度都是这条规则算出来的真实值，不是摆出来的装饰。
 *
 * 那枚橙色只标记「当前太阳的位置」——全站最新一篇文章的角度。
 * 每发一篇新文章，太阳就会移动。这是这个站的签名，也是它无法被套模板的原因。
 */

const DEG_PER_MONTH = 30;

/**
 * 日期 → 角度（自 12 点方向顺时针，取整度）
 */
export function sunAngle(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const deg = (month - 1) * DEG_PER_MONTH + (day / 30) * DEG_PER_MONTH;
  return Math.round(deg) % 360;
}

/**
 * 角度的展示形态：补零三位，77 → 077
 * 补零让索引里的一列角度值等宽，于是那一列本身成为一根刻度轴。
 */
export function sunDeg(date) {
  return String(sunAngle(date)).padStart(3, '0');
}

/**
 * 把文章按年份分组：年份倒序，组内日期倒序。
 * angles 为该年去重后的角度集合 —— 同一天发表的文章共用一根刻针，
 * 所以年环上的刻针数是「几个日期」而不是「几篇文章」。
 */
export function groupByYear(posts) {
  const groups = new Map();

  for (const post of posts) {
    const year = post.date.getFullYear();
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(post);
  }

  return [...groups.keys()]
    .sort((a, b) => b - a)
    .map((year) => {
      const list = groups.get(year);
      return {
        year,
        posts: list,
        angles: [...new Set(list.map((p) => sunAngle(p.date)))],
      };
    });
}
