const peopleNames = ["小林", "阿杰", "小周", "小陈", "小许", "小杨", "小张", "小吴", "小李", "小赵", "小黄", "小郑"];

export const demoOrder = {
  title: "研发组的十二份午饭",
  source: "synthetic",
  items: [
    { id: "burger", name: "麦辣鸡腿汉堡", category: "burger", expected: 12 },
    { id: "fries", name: "中份薯条", category: "fries", expected: 12 },
    { id: "cola", name: "中杯可乐", category: "drink", expected: 8 },
    { id: "tea", name: "锡兰红茶", category: "drink", expected: 4 },
  ],
  people: peopleNames.map((name, index) => ({
    id: `p${index + 1}`, name,
    wants: [
      { itemId: "burger", quantity: 1 },
      { itemId: "fries", quantity: 1 },
      { itemId: index < 8 ? "cola" : "tea", quantity: 1 },
    ],
  })),
};

export const rawDemoOrder = {
  code: 200,
  data: {
    orderProductList: [
      {
        productName: "双人午餐三件套（合成）", quantity: 2,
        comboItemList: [
          { itemName: "麦辣鸡腿汉堡", itemQuantity: 2 },
          { itemName: "中份薯条", itemQuantity: 2 },
          { itemName: "中杯可乐", itemQuantity: 2 },
          { itemName: "不要冰", itemQuantity: 1 },
        ],
      },
      { productName: "锡兰红茶", quantity: 2, comboItemList: [] },
    ],
  },
};
