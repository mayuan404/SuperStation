// 演示代码文件
export function sum(...nums) {
  return nums.reduce((a, b) => a + b, 0)
}

const config = { theme: 'lumen-dark', fontSize: 13 }
console.log(sum(1, 2, 3), config)
